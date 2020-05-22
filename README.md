# Twitch Streams Webhook

NodeJS implementation of a server managing [Twitch Webhook](https://dev.twitch.tv/docs/api/webhooks-guide/) data for the [Streams topic](https://dev.twitch.tv/docs/api/webhooks-reference/#topic-stream-changed).

**This is specific to my use case but might inspire your approach.**

The node server provides endpoints to subscribe and unsubscribe to stream channels. \
It also offers the endpoint for Twitch to call upon an event and another streaming endpoint for pushing the events.

It does basically anything that's required if you want to work with Twitch Webhooks including signing the and verifying the events among other chore. \
Then there's an endpoint which you could use for your application to realize server-sent events for instance.

## Usage

<pre>
<b>ENVIRONMENT</b>
TWITCH_CLIENT_SECRET    Twitch API client secret
TWITCH_CLIENT_ID        Twitch API client ID

<b>OPTIONS</b>
--no-signature          Skip signature check
--no-current-check      Subscribe to Webhook even if there's not CWT tournament
--port 80               Run on port 80 (defaults to 9999)
--host http://abc.com   This server's hostname (defaults to http://localhost)
--help                  Display this help
</pre>
