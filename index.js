const http = require('http');
const fs = require('fs');
const {EventEmitter} = require('events');
const {createHmac} = require('crypto');

const cacheFilePath = '/tmp/nodejs-sse.json';
const cwtInTitle = title => title.match(/\bcwt\b/i) !== null;
const userIdFromUrl = url => parseInt(url.split('/')[2]);
const asEvent = payload => 'data: ' + JSON.stringify(payload) + '\n\n';
const bold = txt => '\033[1m' + txt + '\033[0m';
const assert = (expression, fallback) => {
  try { return expression(); }
  catch { return fallback; }
};

const args = '|' + process.argv.slice(2).join('|') + '|';
const port = assert(() => args.match(/\|--?p(?:ort)? ?([0-9]+)\|/)[1], 9999);
const help = assert(() => args.match(/\|--?h(?:elp)?\|/) != null, false);
const verifySignature = args.indexOf('|--no-signature|') === -1;
const secret = process.env.TWITCH_WEBHOOK_SECRET;
const streams = assert(() => JSON.parse(fs.readFileSync(cacheFilePath).toString()), []);
const hostname = assert(() => args.match(/\|--host (?:https?:\/\/)(.+?)\/?\|/)[1], 'localhost:9999');

if (!secret && verifySignature) {
  console.error('Please provide a secret via environment variable: TWITCH_WEBHOOK_SECRET');
  process.exit(1);
}

if (help) {
  console.info(`
    ${bold('CACHE')}
    Upon exiting the program the current state
    is serialized to ${bold(cacheFilePath)}
    and is read on next startup.

    ${bold('ENVIRONMENT')}
    Environment variable ${bold('TWITCH_WEBHOOK_SECRET')}
    is expected to hold your Twitch Webhook secret.
    
    ${bold('OPTIONS')}
    ${bold('--no-signature')}   Skip signature check
    ${bold('--port 80')}        Run on port 80 (defaults to 9999)
    ${bold('--host abc.com')}   This server's hostname (defaults to localhost)
    ${bold('--help')}           Display this help
  `);

  process.exit(0);
}

const eventEmitter = new EventEmitter();
eventEmitter.setMaxListeners(Infinity); // uh oh

const server = http.createServer((req, res) => {
  req.on('error', err => console.error(err.stack));
  cors(req, res);
  if (req.url.startsWith('/consume')) bodify(req, (body, raw) => consume(req, res, body, raw));
  else if (req.url === '/produce') produce(req, res);
  else if (req.url === '/current') current(req, res);
  else if (req.url.startsWith('/subscribe')) subUnsub(req, res, 'subscribe');
  else if (req.url.startsWith('/unsubscribe')) subUnsub(req, res, 'unsubscribe');
  else endWithCode(res, 404)
}).listen(port);

function consume(req, res, body, raw) {
  console.info('Consume:', raw.trim());

  if (!validateContentLength(req, res, raw)) return;
  if (!validateSignature()) return;

  if (body.data.length !== 0) {
    let newStreams = body.data
        .filter(e => streams.map(s => s.event_id).indexOf(e.id) === -1)
        .filter(e => cwtInTitle(e.title));
    if (newStreams.length === 0) return endWithCode(res, 200);

    streams.push(...body.data.map(e => ({
      event_id: e.id,
      title: e.title,
      user_id: e.user_id,
      user_name: e.user_name
    })))
  } else { // stream's gone off
    const userId = userIdFromUrl(req.url);
    streams.splice(streams.findIndex(s => s.user_id === userId), 1)
  }

  eventEmitter.emit('stream');
  endWithCode(res, 200)
}

function produce(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  res.write(asEvent(streams));

  const eventListener = () => res.write(asEvent(streams));
  eventEmitter.addListener('stream', eventListener);
  res.on('close', () => eventEmitter.removeListener('stream', eventListener))
}

function subUnsub(req, res, subUnsubAction) {
  const userId = userIdFromUrl(req.url);
  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    }
  };

  const twitchReq = http.request(
      'https://api.twitch.tv/helix/webhooks/hub',
      options, () => console.info(`Subscribed to ${userId}`));

  twitchReq.on('error', console.error);

  twitchReq.write(JSON.stringify({
    "hub.callback": `http://${hostname}/consume/${userId}`,
    "hub.mode": subUnsubAction,
    "hub.topic": 'https://api.twitch.tv/helix/streams',
    "hub.secret": secret,
  }));
  twitchReq.end()
}

function bodify(req, cb) {
  let body = '';
  req
      .on('data', chunk => body += chunk)
      .on('end', () => cb(JSON.parse(body), body))
}

function current(req, res) {
  res.setHeader('Content-Type', 'application/json');
  endWithCode(res, 200, JSON.stringify(streams))
}

function validateSignature(req, res, raw) {
  if (!verifySignature) return true;

  const signature = req.headers['X-Hub-Signature'];
  const expectedSignature = createHmac('sha256', secret)
      .update(raw)
      .digest('hex');

  if (signature !== `sha256=${expectedSignature}`) {
    console.error('Invalid signature.');
    endWithCode(res, 400);
    return false
  }
}

function validateContentLength(req, res, raw) {
  const contentLengthHeader = req.headers['content-length'];
  if (contentLengthHeader == null) {
    endWithCode(res, 411);
    return false
  }

  const contentLengthFactual = Buffer.byteLength(raw, 'utf8');
  if (parseInt(contentLengthHeader) !== contentLengthFactual) {
    console.error('Content-Length mismatch.');
    endWithCode(res, 400);
    return false
  }

  return true
}

function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS,POST,PUT");
  res.setHeader("Access-Control-Allow-Headers", "*")
}

function endWithCode(res, code, payload) {
  res.statusCode = code;
  res.end(payload)
}

function shutdownHook() {
  server.close(console.error);
  fs.writeFileSync(cacheFilePath, JSON.stringify(streams));
  console.info('Exiting');
  process.exit(0)
}

['SIGINT', 'SIGTERM', 'SIGQUIT'].forEach(sig => process.on(sig, shutdownHook));

