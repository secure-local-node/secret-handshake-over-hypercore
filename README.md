secret-handshake-over-hypercore
===============================

A variant of [Tarr's Secret
Handshake](https://dominictarr.github.io/secret-handshake-paper/shs.pdf) over
a shared [Hypercore](https://github.com/mafintosh/hypercore) feed to
create secure ephemeral authenticated channels based on capabilities. Ephemeral
secure channels are private Hypercore feeds replicating in the shared feed. The
key pairs are random and based on the session. Even if the shared key
and the public key of each identity communicating over the channel is
compromised the ephemeral feeds encrypt each message based on a
established shared encryption key and a incremented nonce that
corresponds to the message index in the feed.

## Installation

```sh
$ npm install secret-handshake-over-hypercore
```

## Usage

```js
const shh = require('secret-handshake-over-hypercore')
// connect to peer
shh.connect(sharedKey, opts)
// generate a key pair
shh.keygen() // returns publicKey and secretKey pair
// create capability
shh.capability('my capability') // returns 32 byte blake2b hash of 'my capability' (without white space)
// or a keyed capability
shh.capability('my capability', publicKey)
```

## Example

The example below demonstrates a connection between a client and a
server where `read` and `write` capabilities are required. If both
partities do not have an equal intersection of capabilities, then
authentication will fail and the streams will connect.

### Server

```js
const shh = require('secret-handshake-over-hypercore')
const net = require('net')

const sharedKey = Buffer.from('12abf5a9165201b0d5f284d7d902f57b19ca0a6f974bcd8fcc3162c93b2b75f1', 'hex')
const server = net.createServer((socket) => {
  const stream = shh.connect(sharedKey, {
    connect() { return socket },
    capabilities: [
      shh.capability('read'),
      shh.capability('write'),
    ]
  })

  stream.on('handshake', () => {
    stream.write('hello')
  })
})

server.listen(3000)

### Client

```js
const shh = require('secret-handshake-over-hypercore')
const sharedKey = Buffer.from('12abf5a9165201b0d5f284d7d902f57b19ca0a6f974bcd8fcc3162c93b2b75f1', 'hex')
const stream = shh.connect(sharedKey, {
  connect() { return new.connect(3000) },
  capabilities: [
    shh.capability('write'),
    shh.capability('read'),
  ]
})

stream.on('handshake', () => {
  stream.write('hello')
})
```

## How?

This module uses a shared key to create a hypercore replication feed
that is read only. This feed is the initial feed used to create a secure
channel for **sender** and **receiver** hypercore feeds that both sides
of the connection have to read from and write to. These hypercore feeds
are used to exchange enough messages using a secret handshake to create
a shared secret key. The **sender** and **receiver** feeds are
re-established with session key pairs and the shared secret key is used to
box messages that are written to both sides. The initial feed's public
key is a blake2b hash of the shared key. The shared key is _never_
shared.

## API

### `shh.keygen()`

Generate an `ed25519` key pair. The `publicKey` is suitable for use as a
_shared key_ and can be delegated securely to interested parties.

```js
const { publicKey, secretKey } = shh.keygen()
```

### `stream = shh.connect(sharedKey, opts)`

Creates an encrypted connection for a `sharedKey` over a stream
connected to `Duplex` stream like `net.Socket`.

```js
const stream = shh.connect(sharedKey
```


### `shh.capability('capability')`

TODO

### `shh.Connection(opts)`

TODO

## License

MIT
