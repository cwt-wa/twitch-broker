const http = require('http')
const fs = require('fs')
const {EventEmitter} = require('events')
const {createHmac} = require('crypto')

const cacheFilePath = '/tmp/nodejs-sse.json'
const cwtInTitle = title => title.match(/\bcwt\b/i) !== null
const userIdFromUrl = url => parseInt(url.split('/')[2])
const bold = txt => '\033[1m' + txt + '\033[0m'
const assert = (expression, fallback) => {
  try { return expression(); }
  catch { return fallback; }
}

const args = '|' + process.argv.slice(2).join('|') + '|'
const port = assert(() => args.match(/\|--?p(?:ort)?\ ?([0-9]+)\|/)[1], 9999)
const help = assert(() => args.match(/\|--?h(?:elp)?\|/) != null, false)
const verifySignature = args.indexOf('|--no-signature|') === -1
const secret = process.env.TWITCH_WEBHOOK_SECRET
const streams = assert(() => JSON.parse(fs.readFileSync(cacheFilePath).toString()), [])
const hostname = assert(() => args.match(/\|--host\ (?:https?:\/\/)(.+?)\/?\|/)[1], 'localhost:9999')

if (help) {
  console.log(`
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
    ${bold('--host abc.com')}   This server's hostname (defaults to localhost:9999)
    ${bold('--help')}           Display this help
  `)

  process.exit(0)
}

const eventEmitter = new EventEmitter()
eventEmitter.setMaxListeners(Infinity) // uh oh

const server = http.createServer((req, res) => {
  req.on('error', err => console.error(err.stack))
  cors(req, res)
  if (req.url.startsWith('/consume')) bodify(req, (body, raw) => consume(req, res, body, raw))
  else if (req.url === '/produce') produce(req, res)
  else if (req.url === '/current') current(req, res)
  else if (req.url.startsWith('/subscribe')) subUnsub(req, res, 'subscribe')
  else if (req.url.startsWith('/unsubscribe')) subUnsub(req, res, 'unsubscribe')
  else endWithCode(res, 404)
}).listen(port)

function consume(req, res, body, raw) {
  if (!validateContentLength(req, res, raw)) return
  if (!validateSignature()) return

  if (body.data.length !== 0) {
    let newStreams = body.data
      .filter(e => streams.map(s => s.event_id).indexOf(e.id) === -1)
      .filter(e => cwtInTitle(e.title))
    if (newStreams.length === 0) return endWithCode(res, 200)

    streams.push(...body.data.map(e => ({
      event_id: e.id,
      title: e.title,
      user_id: e.userId
    })))
  } else { // stream's gone off
    const userId = userIdFromUrl(req.url)
    streams.splice(streams.findIndex(s => s.user_id === userId), 1)
  }

  eventEmitter.emit('stream')
  endWithCode(res, 200)
}

function produce(req, res) {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  
  res.write(JSON.stringify(streams))
  
  const eventListener = () => res.write(JSON.stringify(streams))
  eventEmitter.addListener('stream', eventListener)
  res.on('close', () => eventEmitter.removeListener('stream', eventListener))
}

function subUnsub(req, res, subUnsubAction) {
  const userId = userIdFromUrl(req.url)
  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    }
  }

  var twitchReq = http.request(
      'https://api.twitch.tv/helix/webhooks/hub',
      options, res => console.log(`Subscribed to ${userId}`))
    
  twitchReq.on('error', console.log)

  twitchReq.write(JSON.stringify({
    "hub.callback": `http://${hostname}/consume/${userId}`,
    "hub.mode": subUnsubAction,
    "hub.topic": 'https://api.twitch.tv/helix/streams',
    "hub.secret": secret,
    "hub.lease_seconds": 0 // for testing
  }))
  twitchReq.end()
}

function bodify(req, cb) {
  let body = ''
  req
    .on('data', chunk => body += chunk)
    .on('end', () => cb(JSON.parse(body), body))
}

function current(req, res) {
  res.setHeader('Content-Type', 'application/json')
  endWithCode(res, 200, JSON.stringify(streams))
}

function validateSignature(req, res, raw) {
  if (!verifySignature) return true;

  const signature = req.headers['X-Hub-Signature']
  const expectedSignature = createHmac('sha256', secret)
                              .update(raw)
                              .digest('hex')

  if (signature !== `sha256=${expectedSignature}`) {
    console.log('Invalid signature.')
    endWithCode(res, 400)
    return false
  }
}

function validateContentLength(req, res, raw) {
  const contentLengthHeader = req.headers['content-length']
  if (contentLengthHeader == null) {
    endWithCode(res, 411)
    return false
  }

  const contentLengthFactual = Buffer.byteLength(raw, 'utf8')
  if (parseInt(contentLengthHeader) !== contentLengthFactual) {
    console.log('Content-Length mismatch.');
    endWithCode(res, 400)
    return false
  }

  return true
}

function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader("Access-Control-Allow-Credentials", "true")
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS,POST,PUT")
  res.setHeader("Access-Control-Allow-Headers", "*")
}

function endWithCode(res, code, payload) {
  res.statusCode = code
  res.end(payload)
}

function shutdownHook() {
  server.close(err => console.error(err))
  fs.writeFileSync(cacheFilePath, JSON.stringify(streams));
  process.exit(0)
}

['SIGINT', 'SIGTERM', 'SIGQUIT'].forEach(sig => process.on(sig, shutdownHook))
