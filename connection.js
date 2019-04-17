const { Duplex } = require('readable-stream')
const { keygen } = require('./keygen')
const increment = require('increment-buffer')
const hypercore = require('hypercore')
const crypto = require('ara-crypto')
const Batch = require('batch')
const debug = require('debug')('secret-handshake-over-hypercore:connection')
const pump = require('pump')
const ram = require('random-access-memory')

const $encryptionKey = Symbol('encryptionKey')
const $hasHandshake = Symbol('hasHandshake')
const $connecting = Symbol('connecting')
const $connected = Symbol('connected')
const $receiver = Symbol('receiver')
const $reading = Symbol('reading')
const $counter = Symbol('counter')
const $sender = Symbol('sender')
const $stream = Symbol('stream')
const $name = Symbol('name')

class Connection extends Duplex {
  static get FEED() { return 'feed' }
  static get TXI() { return 'txi' }
  static get RXI() { return 'rxi' }
  static get TX() { return 'tx' }
  static get RX() { return 'rx' }

  constructor(opts) {
    super(Object.assign({ emitClose: true }, opts))
    this.setMaxListeners(0)

    if (undefined !== opts.connect && 'function' !== typeof opts.connect) {
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

    if (opts.stream) {
      this.createConnection = () => opts.stream
    } else if ('function' === typeof opts.connect) {
      this.createConnection = opts.connect
    } else {
      this.createConnection = null
    }

    this.preserveReceiver = Boolean(opts.preserveReceiver)
    this.preserveSender = Boolean(opts.preserveSender)
    this.allowHalfOpen = Boolean(opts.allowHalfOpen)

    this.createStorage = opts.storage || (() => ram)

    this.remoteSessionPublicKey = null
    this.remotePublicKey = null

    const sessionKeyPair = keygen()
    this.sessionPublicKey = sessionKeyPair.publicKey
    this.sessionSecretKey = sessionKeyPair.secretKey

    this.sharedKey = opts.sharedKey
    this.feedKey = crypto.blake2b(this.sharedKey)

    if (Array.isArray(opts.capabilities)) {
      this.capabilities = opts.capabilities
    } else {
      this.capabilities = []
    }

    for (let i = 0; i < this.capabilities.length; ++i) {
      if (!this.capabilities[i]) {
        delete this.capabilities[i]
      }

      if ('string' === typeof this.capabilities[i]) {
        this.capabilities[i] = Buffer.from(this.capabilities[i])
      }

      if (false === Buffer.isBuffer(this.capabilities[i])) {
        this.capabilities[i] = Buffer.from(this.capabilities[i])
      }
    }

    this.remoteNonce = null
    this.nonce = null

    this.capabilities = this.capabilities
      .filter(Buffer.isBuffer)
      .sort(Buffer.compare)

    this[$encryptionKey] = null
    this[$hasHandshake] = false
    this[$connecting] = false
    this[$connected] = false
    this[$receiver] = null
    this[$reading] = false
    this[$counter] = 0
    this[$stream] = null

    this.feed = this.createHypercore(
      Connection.FEED,
      this.feedKey,
      {
        storageCacheSize: 0,
        sparse: true
      }
    )

    this[$sender] = this.createHypercore(
      Connection.TXI,
      this.publicKey,
      {
        storageCacheSize: 0,
        storeSecretKey: false,
        secretKey: this.secretKey,
        sparse: true,
      }
    )

    this.feed.ready(() => {
      this.emit(Connection.FEED, this.feed)
    })

    this.sender.ready(() => {
      this.emit(Connection.TXI, this.sender)
    })

    this.once('close', () => {
      this[$hasHandshake] = false
      this[$connecting] = false
      this[$connected] = false
      this[$receiver] = null
      this[$reading] = false
      this[$counter] = 0
      this[$sender] = null
      this[$stream] = null

      this.feed = null
    })

    this.cork()
    this.pause()
  }

  get encryptionKey() {
    return this[$encryptionKey]
  }

  get hasHandshake() {
    return this[$hasHandshake]
  }

  get connecting() {
    return this[$connecting]
  }

  get connected() {
    return this[$connected]
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
    const { sender } = this
    if (this.encryptionKey && this.writable && !this.destroyed) {
      const key = crypto.kdf.derive(this.encryptionKey, this.sender.length + 1)
      const nonce = increment(this.nonce)
      const boxed = crypto.box(chunk, { key, nonce })
      const signature = crypto.ed25519.sign(boxed, this.secretKey)
      this.sender.append(Buffer.concat([ signature, boxed ]), done)
    } else {
      done()
    }
  }

  _destroy(err, done) {
    if (err && err.message) {
      this.emit('error', err)
    }

    const batch = new Batch()
    this.stopReading()

    if (this[$stream]) {
      batch.push((done) => this[$stream].once('close', done).destroy())
    }

    if (this.feed) {
      this.feed.cancel(this.feed.length)
      batch.push((done) => this.feed.close(done))
    }

    if (this.sender) {
      this.sender.cancel(this.sender.length)
      batch.push((done) => this.sender.close(done))
    }

    if (this.receiver) {
      this.receiver.cancel(this.receiver.length)
      batch.push((done) => this.receiver.close(done))
    }

    batch.end((err) => {
      if (err) {
        done(err)
      } else {
        process.nextTick(done)
      }
    })
  }

  createHypercore(name, publicKey, opts) {
    const core = hypercore(this.createStorage(name), publicKey, opts)
    return Object.assign(core, { [$name]: name })
  }

  doWrite(buffer, cb) {
    process.nextTick(() => {
      if (this.writable && !this.destroyed) {
        this.sender.append(buffer, cb)
      }
    })
  }

  connect(cb) {
    const { sessionPublicKey, publicKey } = this
    const stream = this.feed.replicate({
      userData: publicKey,
      download: false,
      upload: false,
      live: true,
    })

    const wire = 'function' === typeof this.createConnection
      ? this.createConnection(this)
      : this.createConnection

    const pipe = wire ? pump(stream, wire, stream) : stream

    this[$connecting] = true

    stream.on('feed', (discoveryKey) => {
      const { remotePublicKey } = this
      if (!this.connecting) { return }
      if (0 == Buffer.compare(discoveryKey, this.feed.discoveryKey)) {
        return
      }
      if (
        Buffer.isBuffer(remotePublicKey) &&
        0 === Buffer.compare(this.receiver.discoveryKey, discoveryKey)
      ) {
        this[$connecting] = false
        this[$connected] = true
        this.emit('connect', pipe, {
          sessionPublicKey,
          remotePublicKey,
          discoveryKey,
          publicKey,
        })
      }
    })

    stream.on('handshake', () => {
      const remotePublicKey = stream.remoteUserData

      if (Buffer.isBuffer(this.remotePublicKey)) {
        return
      }

      if (0 === Buffer.compare(this.publicKey, remotePublicKey)) {
        return
      }

      this.remotePublicKey = remotePublicKey

      this.emit('hypercore-handshake', {
        remotePublicKey,
        publicKey,
      }, stream)

      this[$stream] = stream
      this[$receiver] = this.createHypercore(
        Connection.RXI,
        remotePublicKey,
        {
          storageCacheSize: 0,
          sparse: true
        }
      )

      this.sender.replicate({
        download: false,
        upload: true,
        live: true,
        stream,
      })

      this.receiver.ready(() => {
        this.emit(Connection.RXI, this.receiver)

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
      this.handshake(cb)
    })

    return pipe
  }

  stopReading() {
    this[$reading] = false
  }

  startReading() {
    const kick = () => {
      if (!this.readable || this.destroyed) {
        this.stopReading()
      }

      if (this[$reading]) {
        const { receiver } = this
        debug('clear %d-%d', 0, this[$counter], receiver.length)
        receiver.get(this[$counter], { wait: true }, (err, buf) => {
          if (err) {
            onread(err)
          } else if (true !== this.preserveReceiver) {
            receiver.clear(++this[$counter], (err) => onread(err, buf))
          } else {
            onread(null, buf)
          }
        })
      }
    }

    const onread = (err, buf) => {
      if (err) {
        this.stopReading()
        if (!err.message.toLowerCase().match(/request cancelled/)) {
          this.emit('error', err)
        }
      } else if (buf && this[$reading]) {
        if (this.encryptionKey && this.remoteNonce) {
          const key = crypto.kdf.derive(this.encryptionKey, this.counter)
          const nonce = increment(this.remoteNonce)
          const boxed = buf.slice(64)
          const signature = buf.slice(0, 64)
          try {
            const unboxed = crypto.unbox(boxed, { key, nonce })
            if (crypto.ed25519.verify(signature, boxed, this.remotePublicKey)) {
              this.push(unboxed)
            } else {
              err = new Error('Incoming message failed verification')
              this.emit('error', err)
            }
          } catch (err) {
            this.emit('error', err)
          }
        } else {
          this.push(buf)
        }
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
        crypto.curve25519.shared(
          this.publicKey,
          remoteSessionPublicKey
        )
      )

      let verified = crypto.auth.verify(mac, this.remotePublicKey, key)

      if (true !== verified) {
        const err = new Error('Handshake failed verification in hello')
        if ('function' === typeof cb) { cb(err) }
        else { this.emit('error', err) }
        return
      }

      this.remoteSessionPublicKey = remoteSessionPublicKey
      this.remoteNonce = crypto.blake2b(mac, 24)

      this.emit('hello', {
        remoteSessionPublicKey: this.remoteSessionPublicKey,
        remotePublicKey: this.remotePublicKey,
        verified,
        mac,
      })

      this.auth()
      this.once('data', (buf) => {
        const capabilities = Buffer.concat(this.capabilities)
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
          )),
        ])

        const signature = unboxed.slice(32, 32 + 64)
        const remoteCapabilities = unboxed.slice(32 + signature.length)

        verified = crypto.ed25519.verify(signature, proof, remotePublicKey)

        if (true !== verified) {
          const err = new Error('Handshake failed verification in hello')
          if ('function' === typeof cb) { cb(err) }
          else { this.emit('error', err) }
          return
        }

        const intersection = []

        for (let i = 0; i < remoteCapabilities.length; i += 32) {
          const capability = remoteCapabilities.slice(i, i + 32)
          if (capabilities.indexOf(capability) > -1) {
            intersection.push(capability)
          }
        }

        if (0 === intersection.length && capabilities.length) {
          const err = new Error('Handshake failed capability check in auth')
          if ('function' === typeof cb) { cb(err) }
          else { this.emit('error', err) }
          return
        }

        this.sessionCapabilities = intersection.sort(Buffer.compare)

        this.emit('auth', {
          remoteSessionPublicKey: this.remoteSessionPublicKey,
          sessionCapabilities: this.sessionCapabilities,
          remotePublicKey: this.remotePublicKey,
          signature,
          verified,
          proof,
        })

        this.okay(unboxed)
        this.once('data', (buf) => {
          const key = Buffer.concat([
            this.sharedKey,
            crypto.curve25519.shared(
              this.sessionPublicKey,
              this.remoteSessionPublicKey,
            ),
            crypto.curve25519.shared(
              this.sessionPublicKey,
              this.remotePublicKey,
            ),
            crypto.curve25519.shared(
              this.publicKey,
              this.remoteSessionPublicKey,
            )
          ])

          const proof = Buffer.concat([
            this.sharedKey,
            crypto.blake2b(crypto.curve25519.shared(
              this.sessionPublicKey,
              this.remoteSessionPublicKey
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

          this[$encryptionKey] = Buffer.concat([
            key,
            Buffer.concat(this.sessionCapabilities)
          ])

          const pending = new Batch()
          const stream = this[$stream]

          pending.push((next) => this.receiver.close(() => next()))
          pending.push((next) => this.sender.close(() => next()))

          pending.push((next) => {
            this[$sender] = this.createHypercore(
              Connection.TX,
              this.sessionPublicKey,
              {
                storageCacheSize: 0,
                storeSecretKey: false,
                secretKey: this.sessionSecretKey,
                sparse: true,
              }
            )

            this.sender.on('upload', (index) => {
              if (true !== this.preserveSender) {
                this.sender.clear(index)
              }
            })

            this.sender.ready(() => {
              this.emit(Connection.TX, this.sender)
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
            this[$receiver] = this.createHypercore(
              Connection.RX,
              this.remoteSessionPublicKey,
              {
                storageCacheSize: 0,
                sparse: true
              }
            )

            this.receiver.ready(() => {
              this.emit(Connection.RX, this.receiver)
              next()
            })

            this.receiver.replicate({
              download: true,
              upload: false,
              live: true,
              stream,
            })
          })

          pending.end(() => {
            this[$hasHandshake] = true
            this[$counter] = 0

            this.emit('handshake', this)
            this.resume()
            this.uncork()
            this.startReading()
            if ('function' === typeof cb) {
              cb(null)
            }
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

    this.nonce = crypto.blake2b(mac, 24)
    this.doWrite(buffer)
  }

  auth() {
    const {
      remotePublicKey,
      publicKey,
      secretKey,
      sharedKey,
      nonce,
    } = this

    const capabilities = Buffer.concat(this.capabilities)
    const proof = Buffer.concat([
      sharedKey,
      remotePublicKey,
      crypto.blake2b(crypto.curve25519.shared(
        this.sessionPublicKey,
        this.remoteSessionPublicKey,
      )),
    ])

    const signature = crypto.ed25519.sign(proof, secretKey)
    const auth = Buffer.concat([ publicKey, signature, capabilities ])
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

    this.doWrite(box)
  }

  okay(auth) {
    const remotePublicKey = auth.slice(0, 32)
    const signature = auth.slice(32)
    const { nonce } = this

    const key = Buffer.concat([
      this.sharedKey,
      crypto.curve25519.shared(
        this.remoteSessionPublicKey,
        this.sessionPublicKey,
      ),
      crypto.curve25519.shared(
        this.remoteSessionPublicKey,
        this.publicKey,
      ),
      crypto.curve25519.shared(
        this.remotePublicKey,
        this.sessionPublicKey,
      )
    ])

    const proof = Buffer.concat([
      this.sharedKey,
      crypto.blake2b(crypto.curve25519.shared(
        this.remoteSessionPublicKey,
        this.sessionPublicKey
      ))
    ])

    const sig = crypto.ed25519.sign(proof, this.secretKey)
    const box = crypto.box(sig, { key, nonce })

    this.doWrite(box)
  }

  close(cb) {
    if (this[$sender]) {
      this[$sender].close()
    }
    if (this[$stream]) {
      this[$stream].destroy()
    }

    if (this.feed) {
      this.feed.close()
    }
    
    this.emit('close', cb)
  }
}

module.exports = {
  Connection,
}
