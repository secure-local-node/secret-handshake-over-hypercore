const Socket = require('simple-websocket')
const pump = require('pump')
const shh = require('./')

const sharedKey = Buffer.from('12abf5a9165201b0d5f284d7d902f57b19ca0a6f974bcd8fcc3162c93b2b75f1', 'hex')
const socket = new Socket('ws://localhost:3000')

socket.on('connect', () => {
  global.alice = shh.connect(sharedKey, { connect: () => socket })

  alice.on('handshake', () => {
    console.log('alice handshake')
    alice.name = 'alice'
    alice.write('hello bob')
    alice.on('readable', () => {
      console.log('%s', alice.read().toString())
    })
  })
})