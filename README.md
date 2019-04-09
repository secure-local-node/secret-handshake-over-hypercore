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
sh.connect(sharedKey, opts)
// create capability
shh.capability('my capability') // returns 32 byte blake2b hash of 'my capability' (without white space)
```

## Example

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
    stream.write('hello world')
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
    shh.capability('read'),
    shh.capability('write'),
  ]
})
```

## API

### `shh.connect(sharedKey, opts)`

TODO

### `shh.capability('capability')`

TODO

### `shh.keygen()`

TODO

### `shh.Connection(opts)`

TODO

## License

MIT
