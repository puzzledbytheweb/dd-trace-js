'use strict'

const RetryOperation = require('../operation')
const { Kafka } = require('../../../../../versions/kafkajs').get()

function waitForKafka () {
  return new Promise((resolve, reject) => {
    const operation = new RetryOperation('kafkajs')
    operation.attempt(async currentAttempt => {
      try {
        const kafka = new Kafka({
          clientId: `kafkajs-setup-test`,
          brokers: [`localhost:9092`]
        })

        const admin = kafka.admin()
        await admin.connect()

        const { CONNECT } = admin.events

        admin.on(CONNECT, async e => {
          await admin.disconnect()
          resolve()
        })
      } catch (error) {
        if (operation.retry(error)) return
        if (error) return reject(error)
      }
    })
  })
}

module.exports = waitForKafka
