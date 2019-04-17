const { Duplex } = require('readable-stream')
const through = require('through2')
const crypto = require('ara-crypto')
const test = require('tape')
const ram = require('random-access-memory')
const net = require('net')
const shh = require('./')

const sharedKey = crypto.randomBytes(32)

test('shh.capability(name)', (t) => {
  t.throws(() => shh.capability(), Error)
  t.throws(() => shh.capability(null), Error)
  t.throws(() => shh.capability(Buffer.alloc(0)), Error)
  t.throws(() => shh.capability(Buffer.from('')), Error)
  t.equal(32, shh.capability('test').length)
  t.equal(0, Buffer.compare(crypto.blake2b(Buffer.from('test')), shh.capability('test')))
  t.equal(0, Buffer.compare(crypto.blake2b(Buffer.from('authtestcap')), shh.capability('auth test cap')))
  t.equal(0, Buffer.compare(crypto.blake2b(Buffer.from('auth test cap')), shh.capability('auth test cap', false)))
  t.notEqual(0, Buffer.compare(crypto.blake2b(Buffer.from('authtestcap')), shh.capability('auth test cap', false)))
  t.end()
})

test('shh.connect(sharedKey, opts)', (t) => {
  let connectCalled = true

  t.throws(() => shh.connect(), Error)
  t.throws(() => shh.connect(null), Error)
  t.throws(() => shh.connect(sharedKey, { connect: {} }), Error)
  t.throws(() => shh.connect(sharedKey, { connect: null }), Error)

  const stream = shh.connect(sharedKey, { connect })

  stream.once('close', () => t.true(connectCalled))
  stream.once('close', () => t.end())

  process.nextTick(() => stream.destroy())

  function connect(conn) {
    t.equal(conn, stream)
    connectCalled = true
    return through()
  }
})

test('alice <> bob without capabilities', (t) => {
  t.plan(8)

  const server = new Duplex({
    read() { },
    write(chunk, enc, done) {
      client.push(chunk)
      done(null)
    }
  })

  const client = new Duplex({
    read() { },
    write(chunk, enc, done) {
      server.push(chunk)
      done(null)
    }
  })

  const alice = shh.connect(sharedKey, { connect: () => client })
  const bob = shh.connect(sharedKey, { connect: () => server })

  alice.on('handshake', (stream) => {
    t.ok(stream, 'alice handshake') // 1

    alice.once('data', (buf) => {
      t.equal('hello alice', buf.toString(), 'hello from bob') // 2
      alice.destroy()
      client.destroy()
    })

    alice.once('close', () => {
      t.pass('alice closed') // 3
    })

    process.nextTick(() => {
      t.ok(alice.write('hello bob'), 'alice writes to bob') // 4
    })
  })

  bob.on('handshake', (stream) => {
    t.ok(stream, 'bob handshake') // 5

    bob.once('data', (buf) => {
      t.equal('hello bob', buf.toString(), 'hello from alice') // 6
      bob.destroy()
      server.destroy()
    })

    bob.once('close', () => {
      t.pass('bob closed') // 7
    })

    process.nextTick(() => {
      t.ok(bob.write('hello alice'), 'bob writes to alice') // 8
    })
  })
})