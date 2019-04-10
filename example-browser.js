const Socket = require('simple-websocket')
const crypto = require('ara-crypto')
const pump = require('pump')
const shh = require('./')

const sharedKey = Buffer.from('12abf5a9165201b0d5f284d7d902f57b19ca0a6f974bcd8fcc3162c93b2b75f1', 'hex')
const socket = new Socket('ws://localhost:3000')

socket.on('connect', () => {
  global.alice = shh.connect(sharedKey, {
    preserveSender: true,
    connect: () => socket,
    capabilities: [
      shh.capability('auth'),
      shh.capability('read'),
      shh.capability('write'),
    ],
  })

  alice.on('handshake', () => {
    console.log('alice handshake')
    alice.write('hello bob')
    alice.on('data', (b) => console.log(b.toString()))
    alice.sender.get(0, console.log)
  })
})
