const { Duplex } = require('readable-stream')
const { keygen } = require('./keygen')
const duplexify = require('duplexify')
const hypercore = require('hypercore')
const crypto = require('ara-crypto')
const Batch = require('batch')
const debug = require('debug')('secret-handshake-over-hypercore:connection')
const pump = require('pump')
const ram = require('random-access-memory')

const $receiver = Symbol('receiver')
const $reading = Symbol('reading')
const $counter = Symbol('counter')
const $sender = Symbol('sender')
const $stream = Symbol('stream')

class Connection extends Duplex {
  constructor(opts) {
    super()
    this.setMaxListeners(0)

    if ('function' !== typeof opts.connect) {
      throw new TypeError('Connection expects a opts.connect(...) factory')
    }

    if (opts.storage && 'function' !== typeof opts.storage) {
      throw new TypeError('Connection expects a opts.storage(...) factory')
    }

    if (Buffer.isBuffer(opts.publicKey) && Buffer.isBuffer(opts.secretKey)) {
      this.publicKey = opts.publicKey
      this.secretKey = opts.secretKey
    } else {
      const { publicKey, secretKey } = keygen()
      this.publicKey = publicKey
      this.secretKey = secretKey
    }

    this.createConnection = opts.connect
    this.createStorage = opts.storage || (() => ram)

    this.remoteSessionPublicKey = null
    this.remotePublicKey = null

    const sessionKeyPair = keygen()
    this.sessionPublicKey = sessionKeyPair.publicKey
    this.sessionSecretKey = sessionKeyPair.secretKey

    this.sharedKey = opts.sharedKey

    this.remoteNonce = null
    this.nonce = null

    this[$receiver] = null
    this[$reading] = false
    this[$counter] = 0
    this[$stream] = null

    this.feed = this.createHypercore('feed', this.sharedKey, {
      storageCacheSize: 0,
      sparse: true
    })

    this[$sender] = this.createHypercore('sender', this.publicKey, {
      storageCacheSize: 0,
      storeSecretKey: false,
      secretKey: this.secretKey,
      sparse: true,
    })

    this.feed.ready(() => {
      this.emit('feed', this.feed)
    })

    this.sender.ready(() => {
      this.emit('sender', this.sender)
    })
  }

  get reading() {
    return this[$reading]
  }

  get receiver() {
    return this[$receiver]
  }

  get sender() {
    return this[$sender]
  }

  get counter() {
    return this[$counter]
  }

  _read(size) {
    void size
  }

  _write(chunk, enc, done) {
    this.sender.append(chunk, () => done(null))
  }

  createHypercore(name, publicKey, opts) {
    return hypercore(this.createStorage(name), publicKey, opts)
  }

  replicate(opts) {
    return this.sender.replicate(opts)
  }

  connect(cb) {
    const { publicKey } = this
    const stream = this.feed.replicate({
      userData: publicKey,
      download: false,
      upload: false,
      live: true,
    })

    const wire = this.createConnection(this)
    const pipe = pump(wire, stream, wire, cb)

    this.pause()
    this.cork()

    this.emit('connection', wire, { publicKey })

    this.sender.replicate({
      download: false,
      upload: true,
      live: true,
      stream,
    })

    stream.on('handshake', () => {
      const remotePublicKey = stream.remoteUserData

      this.remotePublicKey = remotePublicKey

      this.emit('hypercore-handshake', {
        remotePublicKey,
        publicKey,
      })

      this[$stream] = stream

      this[$receiver] = this.createHypercore('receiver', remotePublicKey, {
        storageCacheSize: 0,
        sparse: true
      })

      this.receiver.ready(() => {
        this.emit('receiver', this.receiver)

        this.receiver.replicate({
          download: true,
          upload: false,
          live: true,
          stream,
        })
      })

      this.uncork()
      this.resume()
      this.startReading()
      this.handshake()
    })

    return pipe
  }

  stopReading() {
    this[$reading] = false
  }

  startReading() {
    const kick = () => {
      if (this[$reading]) {
        const { receiver } = this
        debug('clear %d-%d', 0, this[$counter], receiver.length)
        receiver.clear(this[$counter], () => {
          receiver.get(this[$counter]++, { wait: true }, onread)
        })
      }
    }

    const onread = (err, buf) => {
      if (err) {
        this.emit('error', err)
      } else if (buf && this[$reading]) {
        this.push(buf)
      }

      kick()
    }

    if (true !== this[$reading]) {
      this[$reading] = true
      kick()
      return true
    }

    return false
  }

  handshake(cb) {
    this.hello()
    this.once('data', (buf) => {
      const mac = buf.slice(0, 32)
      const remoteSessionPublicKey = buf.slice(32)

      const key = crypto.curve25519.shared(
        this.sharedKey,
        crypto.curve25519.shared(this.publicKey, remoteSessionPublicKey)
      )

      let verified = crypto.auth.verify(mac, this.remotePublicKey, key)

      if (true !== verified) {
        const err = new Error('Handshake failed verification in hello')
        if ('function' === typeof cb) { cb(err) }
        else { this.emit('error', err) }
        return
      }

      this.remoteSessionPublicKey = remoteSessionPublicKey
      this.remoteNonce = mac.slice(0, 24)

      this.emit('hello', {
        sessionKey: this.remoteSessionPublicKey,
        publicKey: this.remotePublicKey,
        verified,
        mac,
      })

      this.auth()
      this.once('data', (buf) => {
        const nonce = this.remoteNonce
        const key = Buffer.concat([
          this.sharedKey,
          crypto.curve25519.shared(
            this.remoteSessionPublicKey,
            this.sessionPublicKey
          ),
          crypto.curve25519.shared(
            this.remoteSessionPublicKey,
            this.publicKey
          ),
        ])

        const unboxed = crypto.unbox(buf, { key, nonce })
        const remotePublicKey = unboxed.slice(0, 32)
        const signature = unboxed.slice(32)

        if (0 !== Buffer.compare(this.remotePublicKey, remotePublicKey)) {
          const err = new Error('Handshake remote public key does not match in auth')
          if ('function' === typeof cb) { cb(err) }
          else { this.emit('error', err) }
          return
        }

        const proof = Buffer.concat([
          this.sharedKey,
          this.publicKey,
          crypto.blake2b(crypto.curve25519.shared(
            this.remoteSessionPublicKey,
            this.sessionPublicKey
          ))
        ])

        verified = crypto.ed25519.verify(signature, proof, remotePublicKey)

        if (true !== verified) {
          const err = new Error('Handshake failed verification in hello')
          if ('function' === typeof cb) { cb(err) }
          else { this.emit('error', err) }
          return
        }

        this.emit('auth', {
          publicKey: this.remotePublicKey,
          signature,
          verified,
        })

        this.okay(unboxed)
        this.once('data', (buf) => {
          const key = Buffer.concat([
            this.sharedKey,
            crypto.curve25519.shared(
              this.publicKey,
              this.remotePublicKey
            ),
          ])

          const proof = Buffer.concat([
            this.sharedKey,
            crypto.blake2b(crypto.curve25519.shared(
              this.publicKey,
              this.remotePublicKey,
            ))
          ])

          const sig = crypto.unbox(buf, {
            nonce: this.remoteNonce,
            key,
          })

          verified = crypto.ed25519.verify(sig, proof, this.remotePublicKey)

          if (true !== verified) {
            const err = new Error('Handshake failed verification in okay')
            if ('function' === typeof cb) { cb(err) }
            else { this.emit('error', err) }
            return
          }

          this.cork()
          this.pause()
          this.stopReading()

          const pending = new Batch()
          const stream = this[$stream]

          pending.concurrency(1)
          pending.push((next) => this.receiver.close(() => next()))
          pending.push((next) => this.sender.close(() => next()))

          pending.push((next) => {
            this[$sender] = this.createHypercore('sender', this.publicKey, {
              storageCacheSize: 0,
              storeSecretKey: false,
              secretKey: this.secretKey,
              sparse: true,
            })

            this.sender.ready(() => {
              this.emit('sender', this.sender)
              next()
            })

            this.sender.replicate({
              download: false,
              upload: true,
              live: true,
              stream,
            })
          })

          pending.push((next) => {
            this.receiver.ready(() => {
              this.emit('receiver', this.receiver)
              next()
            })

            this[$receiver] = this.createHypercore('receiver', remotePublicKey, {
              storageCacheSize: 0,
              sparse: true
            })

            this.receiver.replicate({
              download: true,
              upload: false,
              live: true,
              stream,
            })
          })

          pending.end(() => {
            this.emit('handshake')
            this[$counter] = 0
            this.resume()
            this.uncork()
            this.startReading()

          })
        })
      })
    })
  }

  hello() {
    const {
      remotePublicKey,
      sessionPublicKey,
      publicKey,
      sharedKey,
    } = this

    const key = crypto.curve25519.shared(
      sharedKey,
      crypto.curve25519.shared(remotePublicKey, sessionPublicKey)
    )

    const mac = crypto.auth(publicKey, key)
    const buffer = Buffer.concat([ mac, sessionPublicKey ])

    this.nonce = mac.slice(0, 24)
    process.nextTick(() => this.write(buffer))
  }

  auth() {
    const {
      remotePublicKey,
      publicKey,
      secretKey,
      sharedKey,
      nonce,
    } = this

    const proof = Buffer.concat([
      sharedKey,
      remotePublicKey,
      crypto.blake2b(crypto.curve25519.shared(
        this.sessionPublicKey,
        this.remoteSessionPublicKey,
      ))
    ])

    const signature = crypto.ed25519.sign(proof, secretKey)
    const auth = Buffer.concat([ publicKey, signature ])
    const key = Buffer.concat([
      sharedKey,
      crypto.curve25519.shared(
        this.sessionPublicKey,
        this.remoteSessionPublicKey
      ),
      crypto.curve25519.shared(
        this.sessionPublicKey,
        this.remotePublicKey
      ),

    ])

    const box = crypto.box(auth, { nonce, key })

    process.nextTick(() => this.write(box))
  }

  okay(auth) {
    const { publicKey, secretKey, sharedKey, nonce } = this
    const remotePublicKey = auth.slice(0, 32)
    const signature = auth.slice(32)

    const key = Buffer.concat([
      sharedKey,
      crypto.curve25519.shared(remotePublicKey, publicKey),
    ])

    const proof = Buffer.concat([
      sharedKey,
      crypto.blake2b(crypto.curve25519.shared(
        remotePublicKey,
        publicKey,
      ))
    ])

    const sig = crypto.ed25519.sign(proof, secretKey)
    const box = crypto.box(sig, { key, nonce })

    process.nextTick(() => this.write(box))
  }
}

module.exports = {
  Connection,
}