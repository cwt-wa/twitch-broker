require('dotenv').config();
const http = require('http');
const https = require('https');
const fs = require('fs');
const {EventEmitter} = require('events');
const {createHmac} = require('crypto');

const cwtInTitle = title => title.match(/\bcwt\b/i) !== null;
const userIdFromUrl = url => url.split('/')[2];
const asEvent = (event, payload) => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
const bold = txt => '\033[1m' + txt + '\033[0m';
const assert = (expression, fallback) => {
  try { return expression(); }
  catch { return fallback; }
};

const args = '|' + process.argv.slice(2).join('|') + '|';
const port = assert(() => args.match(/\|--?p(?:ort)?\|([0-9]+)\|/)[1], 9999);
const help = assert(() => args.match(/\|--?h(?:elp)?\|/) != null, false);
const verifySignature = args.indexOf('|--no-signature|') === -1;
const currentTournamentCheck = args.indexOf('|--no-current-check|') === -1;
const hostname = assert(() => args.match(/\|--host\|(https?:\/\/.+?\/?)\|/)[1], 'http://localhost');

console.info('running on port', port);
console.info('exposing as hostname', hostname);

if (help) {
  console.info(`
    ${bold('ENVIRONMENT')}
    ${bold('TWITCH_CLIENT_SECRET')}    Twitch API client secret
    ${bold('TWITCH_CLIENT_ID')}        Twitch API client ID
    ${bold('TWITCH_CWT_HOST')}         Talking to CWT, (i.e. https://cwtsite.com)
    
    ${bold('OPTIONS')}
    ${bold('--no-signature')}          Skip signature check
    ${bold('--no-current-check')}      Subscribe to Webhook even if there's not CWT tournament
    ${bold('--port 80')}               Run on port 80 (defaults to 9999)
    ${bold('--host http://abc.com')}   This server's hostname (defaults to http://localhost)
    ${bold('--help')}                  Display this help
  `);

  process.exit(0);
}

if (!process.env.TWITCH_CLIENT_SECRET || !process.env.TWITCH_CLIENT_ID) {
  console.error('You did not provide required environment variables.');
  process.exit(1);
}

if (!process.env.TWITCH_CLIENT_SECRET && verifySignature) {
  console.error('Please provide a secret via environment variable.');
  process.exit(1);
}

if (!process.env.TWITCH_CWT_HOST) {
  console.error('You did not provide TWITCH_CWT_HOST environment variable.');
  process.exit(1);
}
const cwtHost = (process.env.TWITCH_CWT_HOST.endsWith('/')
    ? cwtHost.slice(0, -1) : process.env.TWITCH_CWT_HOST);
const cwtHostHttpModule = cwtHost.startsWith('https') ? https : http;

if (!process.env.TWITCH_BOT) {
  console.warn("Twitch Bot not configured, won't auto join/part");
}
const twitchBotHost = process.env.TWITCH_BOT;

const eventEmitter = new EventEmitter();
eventEmitter.setMaxListeners(Infinity); // uh oh

let accessToken;
const leaseSeconds = 864000;
const subscriptions = [];
const allChannels = [];
const streams = [];
let shutdown;
let server;

async function retrieveAccessToken() {
  let promiseResolver;
  const promise = new Promise(resolve => promiseResolver = resolve);
  const queryParams = new URLSearchParams({
    "client_id": process.env.TWITCH_CLIENT_ID,
    "client_secret": process.env.TWITCH_CLIENT_SECRET,
    "grant_type": "client_credentials",
  });
  https.request(
    `https://id.twitch.tv/oauth2/token?${queryParams}`,
    {method: 'POST'},
    (twitchRes) => {
      bodify(twitchRes, body => {
        console.info('Response from access token request', body);
        accessToken = body.access_token;
        promiseResolver({res: twitchRes, body});
      });
    }).end();
  return promise;
}

async function revokeAccessToken() {
  let promiseResolver;
  const promise = new Promise(resolve => promiseResolver = resolve);
  const queryParams = new URLSearchParams({
    "client_id": process.env.TWITCH_CLIENT_ID,
    "token": accessToken,
  });
  https.request(
    `https://id.twitch.tv/oauth2/revoke?${queryParams}`,
    {method: 'POST'},
    (twitchRes) => {
      bodify(twitchRes, body => {
        console.info("Revoking access token response", twitchRes.statusCode, body);
        promiseResolver();
      });
    }).end();
  return promise;
}

async function validateAccessToken() {
  let promiseResolver;
  const promise = new Promise(resolve => promiseResolver = resolve);
  https.request(
    `https://id.twitch.tv/oauth2/validate`,
    {
      method: 'GET',
      headers: {
        Authorization: `OAuth ${accessToken}`
      }
    },
    (twitchRes) => {
      bodify(twitchRes, body => {
        console.info('validating access token', twitchRes.statusCode);
        promiseResolver({res: twitchRes, body});
      });
    }).end();
  return promise;
}

function createServer() {
  server = http.createServer(async (req, res) => {
    if (req.url === '/favicon.ico') return endWithCode(res, 404);
    if (req.method === 'OPTIONS') return endWithCode(res, 200);

    const validateRes = await validateAccessToken();
    if (!validateRes.res.statusCode.toString().startsWith('2')) {
      await retrieveAccessToken();
    }

    bodify(req, (body, raw) => {
      try {
        console.info(`
${req.method} ${req.url} at ${Date.now()}
Headers: ${JSON.stringify(req.headers)}
Payload: ${body && JSON.stringify(body)}`);
        req.on('error', console.error);
        cors(req, res);
        if (req.url.startsWith('/consume')) consume(req, res, body, raw);
        else if (req.url === '/produce') produce(req, res);
        else if (req.url === '/current') current(req, res);
        else if (req.url === '/subscribe-all') subscribeToAllChannels(res);
        else if (req.url.startsWith('/subscribe')) subUnsub(userIdFromUrl(req.url), 'subscribe', res);
        else if (req.url.startsWith('/unsubscribe')) subUnsub(userIdFromUrl(req.url), 'unsubscribe', res);
        else endWithCode(res, 404)
      } catch (e) {
        console.error(e);
        endWithCode(res, 500);
      }
    });
  }).listen(port);
}

(async () => {
  await retrieveAccessToken();
  allChannels.push(...(await retrieveChannels()));
  const userIds = allChannels.map(c => c.id)
  await subscribeToAllChannels();
  createServer();
  if (currentTournamentCheck) {
    console.info("Checking if CWT is currently in group or playoff stage.");
    const currentTournament = await retrieveCurrentTournament();
    if (currentTournament && currentTournament.status
        && ['GROUP', 'PLAYOFFS'].includes(currentTournament.status)) {
      streams.push(...await retrieveCurrentStreams(userIds));
    } else {
      console.info("There's currently no tournament so am not expecting any streams.");
    }
  } else {
    console.info("Skipping check if there's currently a CWT tournament ongoing.");
    streams.push(...await retrieveCurrentStreams(userIds));
  }
  streams.forEach(s => {
    pingBot(s.user_name, 'join')
      .then(res => console.info("successful join", res))
      .catch(err => consol.error('error joining', err));
  });
})();

async function subscribeToAllChannels(res) {
  const success = [];
  const failure = [];
  for (const c of allChannels) {
    try {
      await subUnsub(c.id, 'subscribe');
      console.info(`Subscribed to ${c.displayName} (${c.id})`);
      success.push(c.id);
    } catch (e) {
      console.error(`Couldn't subscribe to ${c.displayName} (${c.id})`)
      failure.push(c.id);
    }
  }
  setTimeout(() => subscribeToAllChannels(), leaseSeconds * 1000);
  res && endWithCode(res, 200, {success, failure});
}

function consume(req, res, body, raw) {
  const url = new URL(req.url, hostname);
  const hubCallback = url.searchParams.get('hub.challenge');
  if (hubCallback != null) {
    console.info('Verifying callback.', hubCallback);
    const hubMode = url.searchParams.get('hub.mode');
    const hubUserId = new URL(decodeURIComponent(
      url.searchParams.get('hub.topic'))).searchParams.get('user_id');
    if (hubMode === 'unsubscribe') {
      subscriptions.splice(
        subscriptions.indexOf(
          hubUserId),
        1);
      if (subscriptions.length === 0 && shutdown != null) {
        shutdown();
      }
    } else if (hubMode === 'subscribe') {
      subscriptions.push(hubUserId);
    }
    return endWithCode(res, 202, hubCallback);
  }

  console.log("There's a consumption", body);

  if (!validateContentLength(req, res, raw)) return;
  if (!validateSignature(req, res, raw)) return;

  console.info('All validation passed.');

  if (body.data.length !== 0) {
    console.info("stream's gone online or maybe changed.");
    const newStreams = body.data
      .filter(e => !streams.map(s => s.id).includes(e.id))
      .filter(e => cwtInTitle(e.title))
      .map(e => ({
        id: e.id,
        title: e.title,
        user_id: e.user_id,
        user_name: e.user_name
      }));
    console.info('newStreams', newStreams);
    streams.push(...newStreams);
    newStreams.forEach(s => {
      pingBot(s.user_name, 'join')
        .then(res => console.info('join success', res))
        .catch(err => console.error('join error', err));
    });
    if (newStreams.length === 0) return endWithCode(res, 200);
  } else {
    const userId = userIdFromUrl(req.url);
    console.info("stream's gone off for userId", userId);
    if (userId == null) return endWithCode(res, 404);
    let idxOfToBeRemovedStream = streams.findIndex(s => s.user_id === userId);
    const user_name = streams[idxOfToBeRemovedStream].user_name;
    while (idxOfToBeRemovedStream !== -1) {
      streams.splice(idxOfToBeRemovedStream, 1);
      idxOfToBeRemovedStream = streams.findIndex(s => s.user_id === userId);
    }
    pingCwt(userId);
    pingBot(user_name, 'part')
      .then(res => console.info('part success', res))
      .catch(err => console.error('part error', err));
  }

  eventEmitter.emit('stream');
  endWithCode(res, 200);
}

function produce(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write('\n');
  res.write(asEvent('STREAMS', streams));
  setInterval(() => res.write(asEvent('HEARTBEAT', 'HEARTBEAT')), 15000);
  const eventListener = () => res.write(asEvent('STREAMS', streams));
  eventEmitter.addListener('stream', eventListener);
  res.on('close', () => eventEmitter.removeListener('stream', eventListener))
}

function subUnsub(userId, subUnsubAction, res) {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  if (!userId) {
    console.warn("No channel to subscribe to.");
    res && endWithCode(res, 404);
    return Promise.reject("No channel to subscribe to.");
  }
  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'client-id': process.env.TWITCH_CLIENT_ID,
      'Authorization': `Bearer ${accessToken}`
    }
  };
  const twitchReq = https.request(
    'https://api.twitch.tv/helix/webhooks/hub',
    options, (twitchRes) => {
      bodify(twitchRes, body => {
        console.info(`${subUnsubAction}d to ${userId} with HTTP status ${twitchRes.statusCode}`);
        if (twitchRes.statusCode.toString().startsWith('2')) {
          resolvePromise();
        } else {
          rejectPromise();
        }
        res && endWithCode(res, 200);
      });
    });
  twitchReq.on('error', console.error);
  const callbackUrl = `${hostname}/consume/${userId}`;
  console.log('callbackUrl', callbackUrl);
  const topic = `https://api.twitch.tv/helix/streams?user_id=${userId}`;
  console.info(`${subUnsubAction} `, topic);
  twitchReq.write(JSON.stringify({
    "hub.callback": callbackUrl,
    "hub.mode": subUnsubAction,
    "hub.topic": topic,
    "hub.secret": process.env.TWITCH_CLIENT_SECRET,
    "hub.lease_seconds": leaseSeconds,
  }));
  twitchReq.end();
  return promise;
}

function bodify(req, cb) {
  let body = '';
  req
    .on('data', chunk => body += chunk)
    .on('end', () => {
      if (!body) return cb(null);
      try {
        cb(JSON.parse(body), body)
      } catch (e) {
        console.warn('body could not be parsed', e);
        cb(null);
      }
    });
}

function current(req, res) {
  res.setHeader('Content-Type', 'application/json');
  endWithCode(res, 200, JSON.stringify(streams))
}

function validateSignature(req, res, raw) {
  if (!verifySignature) {
    console.log('Skipping signature verification');
    return true;
  }

  const signature = req.headers['x-hub-signature'];
  const expectedSignature = createHmac('sha256', process.env.TWITCH_CLIENT_SECRET)
    .update(raw)
    .digest('hex');

  if (signature !== `sha256=${expectedSignature}`) {
    console.error('Invalid signature.');
    endWithCode(res, 400);
    return false
  }
  console.info('Signature valid.')
  return true;
}

async function retrieveCurrentStreams(userIds) {
  let resolvePromise;
  const promise = new Promise(resolve => resolvePromise = resolve);
  const searchParams = new URLSearchParams(userIds.map(id => ['user_id', id]));
  console.info('Requesting initial streams', userIds);
  if (!searchParams.toString()) {
    return Promise.resolve([]);
  }
  https.request(
    `https://api.twitch.tv/helix/streams?${searchParams}`,
    {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'client-id': process.env.TWITCH_CLIENT_ID,
        'Authorization': `Bearer ${accessToken}`
      }
    },
    twitchRes => {
      bodify(twitchRes, body => {
        console.info("Response for initial streams", body);
        resolvePromise(body.data.map(e => ({
          id: e.id,
          title: e.title,
          user_id: e.user_id,
          user_name: e.user_name
        })));
      })
    }).end();
  return promise;
}

function retrieveChannels() {
  return new Promise(resolve => {
    cwtHostHttpModule.get(cwtHost + '/api/channel',
      (twitchRes) => {
        bodify(twitchRes, body => {
          console.info('Channels are', body.map(c => `${c.id} ${c.displayName}`));
          resolve(body);
        });
      });
  });
}

function retrieveCurrentTournament() {
  let resolvePromise;
  const promise = new Promise(resolve => resolvePromise = resolve);
  cwtHostHttpModule.get(cwtHost + '/api/tournament/current',
    (twitchRes) => {
      bodify(twitchRes, body => {
        resolvePromise(body);
      });
    });
  return promise;
}

function pingCwt(userId) {
  const url = new URL(cwtHost + '/api/channel/ping/' + userId);
  console.info('Pinging CWT with userId', url);
  return new Promise(resolve => {
    const req = cwtHostHttpModule.request(
      toOptions(url, 'POST'), (res) => {
        bodify(res, body => {
          console.info(res.statusCode, body);
          resolve(body);
        });
      });
    req.on('error', err => console.log('error on pinging CWT', err));
    req.end();
  });
}

/**
 * user_login corresponds to the channel to join to
 *  and it's therefore what twitch-bot works with.
 * Unfortunately this information isn't available here.
 * I learnt, though, the user_login is the display_name in all lower case
 *  Therefore that information is in fact available.
 */
function pingBot(userId, action) {
  if (twitchBotHost == null) {
    console.info('No auto join/part as Twitch Bot is not configures');
    return Promise.resolve();
  }
  const url = new URL(`${twitchBotHost}/api/${user_name.toLowerCase()}/auto-${action}`);
  console.info('Pinging Bot', url);
  return new Promise((resolve, reject) => {
    const req = https.request(
      toOptions(url), (res) => {
        bodify(res, body => {
          console.info(res.statusCode, body);
          resolve(body);
        });
      });
    req.on('error', err => {
        console.log(`error on auto-${action}ing bot`, err)
        reject(err);
      });
    req.end();
  });
}

function validateContentLength(req, res, raw) {
  const contentLengthHeader = req.headers['content-length'];
  if (contentLengthHeader == null) {
    console.warn('No Content-Length header.');
    endWithCode(res, 411);
    return false
  }

  const contentLengthFactual = Buffer.byteLength(raw, 'utf8');
  if (parseInt(contentLengthHeader) !== contentLengthFactual) {
    console.error('Content-Length mismatch.');
    endWithCode(res, 400);
    return false
  }

  console.info('Content-Length is valid');
  return true
}

function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS,POST,PUT");
  res.setHeader("Access-Control-Allow-Headers", "*")
}

function toOptions(url, method = 'GET') {
  var options = {
    protocol: url.protocol,
    hostname: typeof url.hostname === 'string' && url.hostname.startsWith('[') ?
      url.hostname.slice(1, -1) :
      url.hostname,
    hash: url.hash,
    search: url.search,
    pathname: url.pathname,
    path: `${url.pathname || ''}${url.search || ''}`,
    href: url.href
  };
  if (url.port !== '') options.port = Number(url.port);
  options.headers = {
    'Content-Type': 'application/json',
    'Content-Length': 0,
  };
  options.method = method;
  return options;
}

function endWithCode(res, code, payload) {
  res.statusCode = code;
  res.end(payload)
}

async function tearDown(code) {
  await revokeAccessToken();
  server.close(console.error);
  process.exit(code);
}

['SIGINT', 'SIGTERM', 'SIGQUIT'].forEach(sig => process.on(sig, async () => {
  const timeout = setTimeout(async () => {
    console.error(
      "Exiting with code 2 because of timeout. " +
      "Not all subscriptions have been unsubscribed.");
    await tearDown();
    process.exit(2);
  }, 10000);
  new Promise(resolve => shutdown = resolve)
    .then(async () => {
      clearTimeout(timeout);
      console.info("All subscriptions have been successfully unsubscribed. Exiting");
      await tearDown(0);
    })
    .catch(async () => {
      clearTimeout(timeout);
      console.info("Some or all subscription have failed to unsubscribe. Exiting");
      await tearDown(1);
    });
  subscriptions.forEach(s => subUnsub(s, 'unsubscribe'));
}));

