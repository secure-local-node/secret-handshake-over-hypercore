secret-handshake-over-hypercore
===============================

A variant of [Tarr's Secret
Handshake](https://dominictarr.github.io/secret-handshake-paper/shs.pdf) over
a shared [Hypercore](https://github.com/mafintosh/hypercore) feed to
create secure ephemeral authenticated channels based on capabilities.

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
shh.capability('my capability') // returns 32 byte BLAKE2b hash of 'my capability' (without white space)
// or a keyed capability
shh.capability('my capability', publicKey)
```

## Example

The example below demonstrates a connection between a client and a
server where `read` and `write` capabilities are required. If both
parties do not have an equal intersection of capabilities, then
authentication will fail and the streams will connect.

### Server

```js
const shh = require('secret-handshake-over-hypercore')
const net = require('net')

const sharedKey = Buffer.from('12abf5a9165201b0d5f284d7d902f57b19ca0a6f974bcd8fcc3162c93b2b75f1', 'hex')
const server = net.createServer((socket) => {
  const stream = shh.connect(sharedKey, {
    stream: socket,
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
```

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
key is a BLAKE2b hash of the shared key. The shared key is _never_
shared.

## API

### `shh.keygen()`

Generate an `ed25519` key pair. The `publicKey` is suitable for use as a
_shared key_ and can be delegated securely to interested parties.

```js
const { publicKey, secretKey } = shh.keygen()
```

### `stream = shh.connect(sharedKey[, opts])`

Creates an encrypted connection for a `sharedKey` over a stream
connected to `Duplex` stream like `net.Socket`.

```js
const stream = shh.connect(sharedKey, {
  connect() {
    return net.connect(3000) // connect to localhost:3000
  }
})
```

Where

* `sharedKey` is a 32 byte buffer containing a unique shared secret key.
  Both parties _must_ have this key
* `opts` is the same as [Connection options](#connection-opts)

### `capability = shh.capability(capabilityType, [, key])`

Creates a 32 byte BLAKE2b hash of `capabilityType` keyed with an optional
32 byte buffer `key`. See [Connection Capablities](#connection-capabilities).

```js
const { publicKey, secretKey } = shh.keygen()
const capabilities = [
  shh.capability('auth', publicKey),
  shh.capability('read', publicKey),
  shh.capability('write', publicKey),
]
```

### `connection = new shh.Connection(opts)`

The `Connection` class is a `Duplex` stream that wraps the handshake
and hypercore feeds used to establish a secure channel. It can be written
to and read from safely after the `'handshake'` event has been emitted.

The constructor accepts a single argument `opts` where:

<a name="connection-opts" />
* `opts.sharedKey` A **required** 32 byte buffer containing a
  unique shared secret key.
* `opts.publicKey` An optional public key for the identity initiating
  the connection
* `opts.secretKey` An optional secret key for the identity initiating
  the connection that is associated with `opts.publicKey`
* `opts.connect` An optional function that should return a `Duplex`
  stream to create a connection to the underlying [hypercore
  replication](https://github.com/mafintosh/hypercore-protocol) stream
* `opts.stream` An optional stream that takes the place of the return
  value of `opts.connect()`
* `opts.storage` An optional factory function that accepts a
  [connection feed type](#connection-feed-types) and returns a
  [random-access-storage interface][ras]
  that will be given to `hypercore(...)`
* `opts.preserveReceiver` An optional boolean to indicate that the
  connection should preserve the receiver (`Connection.RX`) feed
  messages written to it. (Default: `false`)
* `opts.preserveSender` An optional boolean to indicate that the
  connection should preserve the sender (`Connection.TX`) feed
  messages written to it. (Default: `false`)
* `opts.capabilities` An optional array of capabilities that you express
  and require the connecting party to also provide. See [Connection
  Capabilities](#connection-capabilities)

#### `connection.encryptionKey`

The initial shared encryption key used to encrypt messages in the sender
feed. This property is set after the `'handshake'` event is emitted.

#### `connection.hasHandshake`

A predicate boolean to indicate if the connection has completed
the handshake. This should be `true` after the `'handshake'` event is
emitted.

#### `connection.connecting`

A predicate boolean to indicate if the connection is currently in a
connecting phase. This is set to `true` when `connection.connect()` is
called and set to `false` right before the `'connect'` event.

#### `connection.connected`

A predicate boolean to indicate if the connection is currently connected
to another party. This is set to `true` right before the `'connect'`
event is emitted.

#### `connection.reading`

A predicate boolean to indicate if the connection is currently reading
from the other party.

#### `connection.on('handshake', connection)`

Emitted when the connection establishes a handshake and can be written
to and read from

#### `connection.on('connect', stream, info)`

Emitted when the connection connects to the remote where `stream`
is the top level replication feed and `info` contains

* `info.publicKey` The connections identity public key
* `info.sessionPublicKey` The ephemeral public key for the
  connection session
* `info.remotePublicKey` The remotes identity public key
* `info.discoveryKey` The hypercore discovery key for the initial
  remote feed

#### `connection.on(Connection.FEED, feed)`

Emitted when the top level hypercore feed is ready.

#### `connection.on(Connection.TXI, sender)`

Emitted when the initial sender hypercore feed is ready.

#### `connection.on(Connection.RXI, receiver)`

Emitted when the initial receiver hypercore feed is ready.

#### `connection.on(Connection.TX, sender)`

Emitted when the session sender hypercore feed is ready.

#### `connection.on(Connection.RX, receiver)`

Emitted when the session receiver hypercore feed is ready.

#### `connection.on('hello', info)`

Emitted when the connection receives a _hello_ from the other
party where `info` contain:

* `info.remoteSessionPublicKey` The remotes ephemeral public key for the
  session
* `info.remotePublicKey` The remotes identity public key

#### `connection.on('auth', info)`

Emitted when the connection has authenticated with the other
party where `info` contains:

* `info.sessionCapabilities` An intersection of the capabilities given by both
  parties for the connection session
* `info.remoteSessionPublicKey` The remotes ephemeral public key for the
  session
* `info.remotePublicKey` The remotes identity public key
* `info.signature` The signature of the authentication proof
* `info.proof` The authentication proof

#### `connection.on('error', err)`

Emitted when a error occurs in the connection.

### Connection Feed Types

The connection established over the stream uses several hypercore feeds
to ensure a secure channel between both parties. The types of feeds used
are represented as string constants and are given to the
`opts.storage(feedType)` factory function, if supplied by the user. This
is useful if you want to provide your own storage backend.

#### `Connection.FEED`

The top level hypercore feed established for a secure symmetric channel.
This feed is never written to.

```js
Connection.FEED = 'feed'
```

#### `Connection.TXI`

The initial sender hypercore feed that both parties establish as an initial
feed to write to that the other party will read from. This feed is used
for the handshake and then destroyed before establishing a session
sender feed. This feed is represented as the `Connection.RXI` feed on
the other end.

```js
Connection.TXI = 'txi'
```

#### `Connection.RXI`

The initial receiver hypercore feed that both parties establish as an initial
feed to read from that the other party will write to. This feed is used
for the handshake and then destroyed before establishing a session
receiver feed. This feed is represented as the `Connection.TXI` feed on
the other end.

```js
Connection.RXI = 'rxi'
```

#### `Connection.TX`

The ephemeral sender hypercore feed that both parties establish after a
handshake. Messages written to this feed are encrypted with a unique key
derived from a shared encryption key, the current message counter, and
an incremented nonce making each message encrypted with a unique key.
This feed is both **readable** and **writable**.

```js
Connection.TX = 'tx'
```

#### `Connection.RX`

The ephemeral receiver hypercore feed that both parties establish after a
handshake. Messages written to this feed are encrypted with a unique key
derived from a shared encryption key, the current message counter, and
an incremented nonce making each message encrypted with a unique key.
This feed is **readable only**.

```js
Connection.RX = 'rx'
```

### Connection Capabilities

Connection capabilities provide a way to require extra information both
parties in the handshake need to know. When given, the handshake
requires that both parties share at least one capability during
authentication. The intersection of the capabilities between two parties
is used as an operand for deriving the initial encryption key used to
encrypt messages in the connection.

Capabilities are created with the `shh.capability()` function.
Capabilities are 32 byte BLAKE2b hashes of the input given to the
function.

```
> shh.capability('auth')
<Buffer f4 77 ca 2d 48 ad 0a 39 77 8a f2 86 e1 2b 90 8d a8 53 12 cb 0b e4 e1 f8 c8 eb c0 fd 2e d4 1c af>
```

Capabilities are given to `shh.connect()` or `new Connection()`. If
capabilities are not desired then both parties should omit them.

## License

MIT


[ras]: https://github.com/random-access-storage/random-access-storage
