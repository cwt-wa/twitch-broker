# Twitch Streams Webhook

NodeJS implementation of a server managing [Twitch Webhook](https://dev.twitch.tv/docs/api/webhooks-guide/) data for the [Streams topic](https://dev.twitch.tv/docs/api/webhooks-reference/#topic-stream-changed).

**Work in progress, untested and sometimes specific to an implementation.**


The node server provides endpoints to subscribe and unsubscribe to stream channels. \
It also offers the endpoint for Twitch to call upon an event and another streaming endpoint for pushing the events.

It does basically anything that's required if you want to work with Twitch Webhooks including signing the and verifyin the events among other chore. \
Then there's an endpoint which you could use for your application to realize server-sent events for instance.

## Usage

<pre>
<b>CACHE</b>
Upon exiting the program the current state
is serialized to <b>/tmp/nodejs-sse.json</b>
and is read on next startup.

<b>ENVIRONMENT</b>
Environment variable <b>TWITCH_WEBHOOK_SECRET</b>
is expected to hold your Twitch Webhook secret.

<b>OPTIONS</b>
--no-signature   Skip signature check
--port 80        Run on port 80 (defaults to 9999)
--host abc.com   This server's hostname (defaults to localhost)
--help           Display this help
</pre>

