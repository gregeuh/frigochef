const functions = require('firebase-functions');
const admin     = require('firebase-admin');
const axios     = require('axios');

admin.initializeApp();
const db = admin.firestore();

const PROJECT_ID   = 'frigochef-95045';
const REGION       = 'us-central1';
const BASE_URL     = `https://${REGION}-${PROJECT_ID}.cloudfunctions.net`;
const CALLBACK_URL = `${BASE_URL}/withingsCallback`;
const NOTIFY_URL   = `${BASE_URL}/withingsNotify`;

const CLIENT_ID     = process.env.WITHINGS_CLIENT_ID;
const CLIENT_SECRET = process.env.WITHINGS_CLIENT_SECRET;

/* ═══════════════════════════════════════════════
   1. withingsAuth — redirige vers la page Withings
   ═══════════════════════════════════════════════ */
exports.withingsAuth = functions.https.onRequest((req, res) => {
  const uid = req.query.uid;
  if (!uid) return res.status(400).send('Paramètre uid manquant');

  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     CLIENT_ID,
    state:         uid,
    scope:         'user.metrics,user.sleepevents,user.activity',
    redirect_uri:  CALLBACK_URL,
  });

  res.redirect(`https://account.withings.com/oauth2_user/authorize2?${params}`);
});

/* ═══════════════════════════════════════════════
   2. withingsCallback — échange le code OAuth2
   ═══════════════════════════════════════════════ */
exports.withingsCallback = functions.https.onRequest(async (req, res) => {
  const { code, state: uid } = req.query;
  if (!code || !uid) return res.status(400).send('Paramètres manquants');

  try {
    const tokenRes = await axios.post(
      'https://wbsapi.withings.net/v2/oauth2',
      new URLSearchParams({
        action:        'requesttoken',
        grant_type:    'authorization_code',
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri:  CALLBACK_URL,
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    if (tokenRes.data.status !== 0) throw new Error(JSON.stringify(tokenRes.data));

    const { access_token, refresh_token, userid } = tokenRes.data.body;

    await db.collection('withingsTokens').doc(uid).set({
      access_token, refresh_token,
      withings_userid: String(userid),
      updatedAt: Date.now(),
    });

    // Abonnement aux notifications push
    await subscribeNotifications(access_token);

    // Récupération initiale des données
    await fetchAndStore(uid, access_token);

    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
      <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f4f6f8}
      .card{background:#fff;border-radius:16px;padding:32px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.1);max-width:340px}
      h2{color:#00875A;margin-bottom:8px}p{color:#64748B}</style></head>
      <body><div class="card"><div style="font-size:3rem">✅</div>
      <h2>Withings connecté !</h2>
      <p>Vos données se synchronisent automatiquement dans NutriHome.</p>
      <p style="margin-top:16px;font-size:.85rem">Vous pouvez fermer cette page.</p>
      </div></body></html>`);

  } catch (err) {
    console.error('withingsCallback error:', err.message);
    res.status(500).send(`Erreur : ${err.message}`);
  }
});

/* ═══════════════════════════════════════════════
   3. withingsNotify — reçoit les notifications push
   ═══════════════════════════════════════════════ */
exports.withingsNotify = functions.https.onRequest(async (req, res) => {
  // Withings envoie une requête HEAD pour valider l'URL
  if (req.method === 'HEAD') return res.status(200).send('ok');

  const userid = req.body?.userid || req.query?.userid;
  if (!userid) return res.status(200).send('ok');

  try {
    const snap = await db.collection('withingsTokens')
      .where('withings_userid', '==', String(userid)).limit(1).get();
    if (snap.empty) return res.status(200).send('ok');

    const uid       = snap.docs[0].id;
    const tokenData = snap.docs[0].data();
    const token     = await refreshToken(uid, tokenData);
    await fetchAndStore(uid, token);
  } catch (err) {
    console.error('withingsNotify error:', err.message);
  }

  res.status(200).send('ok');
});

/* ═══════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════ */
async function refreshToken(uid, tokenData) {
  const r = await axios.post(
    'https://wbsapi.withings.net/v2/oauth2',
    new URLSearchParams({
      action:        'requesttoken',
      grant_type:    'refresh_token',
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: tokenData.refresh_token,
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  if (r.data.status !== 0) throw new Error('refresh failed: ' + JSON.stringify(r.data));
  const { access_token, refresh_token } = r.data.body;
  await db.collection('withingsTokens').doc(uid).update({
    access_token, refresh_token, updatedAt: Date.now(),
  });
  return access_token;
}

async function subscribeNotifications(access_token) {
  for (const appli of [1, 16, 44]) {
    try {
      await axios.post(
        'https://wbsapi.withings.net/notify',
        new URLSearchParams({ action: 'subscribe', callbackurl: NOTIFY_URL, appli: String(appli) }).toString(),
        { headers: {
          'Authorization': `Bearer ${access_token}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        }}
      );
    } catch (e) {
      console.warn(`subscribe appli=${appli} failed:`, e.message);
    }
  }
}

async function fetchAndStore(uid, access_token) {
  const headers = { Authorization: `Bearer ${access_token}` };
  const endDate   = Math.floor(Date.now() / 1000);
  const startDate = endDate - 90 * 24 * 3600; // 90 jours

  // ── Poids & composition corporelle ──
  const measRes = await axios.get('https://wbsapi.withings.net/v2/measure', {
    params: { action: 'getmeas', meastypes: '1,6,8,76,77,88', category: 1 },
    headers,
  });

  if (measRes.data.status === 0) {
    const entries = parseMeasurements(measRes.data.body.measuregrps || []);
    if (entries.length) {
      const existing = await db.collection('weightLog').doc(uid).get();
      const prev = existing.exists ? (existing.data().entries || []) : [];
      const merged = [...prev.filter(e => !entries.find(n => n.date === e.date)), ...entries]
        .sort((a, b) => a.date.localeCompare(b.date));
      await db.collection('weightLog').doc(uid).set({ entries: merged, updatedAt: Date.now() });
    }
  }

  // ── Activité (TDEE) ──
  const actRes = await axios.get('https://wbsapi.withings.net/v2/measure', {
    params: {
      action: 'getactivity',
      startdateymd: tsToDate(startDate),
      enddateymd:   tsToDate(endDate),
      data_fields:  'calories,totalcalories',
    },
    headers,
  });

  let activity = [];
  if (actRes.data.status === 0 && actRes.data.body?.activities) {
    activity = actRes.data.body.activities
      .filter(a => a.totalcalories > 0)
      .map(a => ({
        date:    a.date,
        earned:  Math.round(a.calories || 0),
        passive: Math.round((a.totalcalories || 0) - (a.calories || 0)),
        tdee:    Math.round(a.totalcalories || 0),
      }));
  }

  // ── Sommeil ──
  const sleepRes = await axios.get('https://wbsapi.withings.net/v2/sleep', {
    params: {
      action:        'getsummary',
      startdateymd:  tsToDate(startDate),
      enddateymd:    tsToDate(endDate),
      data_fields:   'lightsleepduration,deepsleepduration,remsleepduration,wakeupduration,hr_average',
    },
    headers,
  });

  let sleep = [];
  if (sleepRes.data.status === 0 && sleepRes.data.body?.series) {
    sleep = sleepRes.data.body.series.map(s => {
      const d = s.data || {};
      const totalS = (d.lightsleepduration || 0) + (d.deepsleepduration || 0) + (d.remsleepduration || 0);
      return {
        date:     tsToDate(s.startdate),
        totalMin: Math.round(totalS / 60),
        lightMin: Math.round((d.lightsleepduration || 0) / 60),
        deepMin:  Math.round((d.deepsleepduration  || 0) / 60),
        remMin:   Math.round((d.remsleepduration   || 0) / 60),
        awakeMin: Math.round((d.wakeupduration     || 0) / 60),
        deepPct:  totalS > 0 ? Math.round((d.deepsleepduration || 0) / totalS * 100) : 0,
        remPct:   totalS > 0 ? Math.round((d.remsleepduration  || 0) / totalS * 100) : 0,
        hrAvg:    d.hr_average || null,
      };
    }).filter(s => s.totalMin > 0);
  }

  // Sauvegarder activité + sommeil
  await db.collection('withingsData').doc(uid).set({
    activity, sleep, updatedAt: Date.now(),
  }, { merge: true });
}

function parseMeasurements(groups) {
  return groups.map(grp => {
    const date  = tsToDate(grp.date);
    const entry = { date };
    grp.measures.forEach(m => {
      const val = m.value * Math.pow(10, m.unit);
      if (m.type === 1)  entry.weight   = Math.round(val * 10) / 10;
      if (m.type === 6)  entry.fatPct   = Math.round(val * 10) / 10;
      if (m.type === 8)  entry.fatKg    = Math.round(val * 10) / 10;
      if (m.type === 76) entry.muscleKg = Math.round(val * 10) / 10;
      if (m.type === 77) entry._waterKg = Math.round(val * 10) / 10;
      if (m.type === 88) entry.boneKg   = Math.round(val * 10) / 10;
    });
    if (!entry.weight) return null;
    if (entry._waterKg) { entry.waterPct = Math.round(entry._waterKg / entry.weight * 1000) / 10; delete entry._waterKg; }
    if (entry.muscleKg) entry.musclePct = Math.round(entry.muscleKg / entry.weight * 1000) / 10;
    return entry;
  }).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));
}

function tsToDate(ts) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

