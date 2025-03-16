import { randomStr, sleep } from '@murongg/utils'
import type { RedisOptions } from 'ioredis'
import Redis from 'ioredis'
import { logger } from './debug'

export type MessageHandler<T> = (message: T) => Promise<void>

export interface Message {
  id: string
  payload: any
  priority: number
}

function stringify(value: any) {
  return JSON.stringify(value)
}

export class MessageQueue {
  private redis: Redis
  private handlers: Map<string, MessageHandler<any>[]>
  private maxRetries: number
  private processing: Set<string> = new Set()
  private ttl = 3600 * 12
  private concurrencyMap: Map<string, number> = new Map()
  private concurrency: number
  private sleepTime = 1000
  private sleepTimeMap: Map<string, number> = new Map()

  constructor(redisUrl: string | RedisOptions, maxRetries = 3, concurrency = 5) {
    this.redis = typeof redisUrl === 'string' ? new Redis(redisUrl) : new Redis(redisUrl)
    this.handlers = new Map()
    this.maxRetries = maxRetries
    for (const key of this.concurrencyMap.keys())
      this.concurrencyMap.set(key, concurrency)

    this.concurrency = concurrency
  }

  async publish<T>(queueName: string, payload: T, id: string = this.generateId(), priority = 0) {
    const message: Message = {
      id,
      payload,
      priority,
    }
    const messageStr = stringify(message)
    // check is exist
    const isExist = await this.redis.zrank(queueName, messageStr)
    if (isExist !== null && isExist !== undefined) {
      logger.log(`[QUEUE - ${queueName}] Message ${message.id} is exist`)
      return
    }
    await this.redis.zadd(queueName, priority, messageStr)
    this.processQueue(queueName)
  }

  subscribe<T>(queueName: string, handler: MessageHandler<T>) {
    if (!this.handlers.has(queueName))
      this.handlers.set(queueName, [])

    this.setConcurrency(queueName, this.concurrency)
    this.setSleepTime(queueName, this.sleepTime)
    this.handlers.get(queueName)?.push(handler)
    this.processQueue(queueName)
  }

  setConcurrency(queueName: string, concurrency: number) {
    this.concurrencyMap.set(queueName, concurrency)
  }

  setSleepTime(queueName: string, sleepTime: number) {
    this.sleepTimeMap.set(queueName, sleepTime)
  }

  private async processQueue(queueName: string) {
    logger.log(`[QUEUE - ${queueName}] Processing queue, processing: ${this.processing.has(queueName)}`)
    if (this.processing.has(queueName))
      return

    this.processing.add(queueName)

    const handlers = this.handlers.get(queueName)

    if (handlers) {
      while (true) {
        const concurrency = this.concurrencyMap.get(queueName) || this.concurrency
        const messages = await this.redis.zpopmin(queueName, concurrency)
        if (messages.length === 0)
          break
        logger.log(`[QUEUE - ${queueName}] Processing ${messages.length / 2} messages`)

        const processingPromises = []
        for (let i = 0; i < messages.length; i += 2) {
          const messageStr = messages[i]
          const message: Message = JSON.parse(messageStr)
          logger.log(`[QUEUE - ${queueName}] Processing message ${message.id}`)
          // eslint-disable-next-line no-useless-call
          processingPromises.push(this.processMessage.call(this, queueName, message, handlers))
        }

        try {
          const results = await Promise.allSettled(processingPromises)

          for (const result of results) {
            if (result.status === 'rejected')
              logger.log(`[QUEUE - ${queueName}] Error processing message batch: ${result.reason}`)
            else
              logger.log(`[QUEUE - ${queueName}] Message batch processed successfully`)
          }
        }
        catch (log) {
          logger.log(`[QUEUE - ${queueName}] Error processing message batch: ${log?.toString()}`)
        }
        const sleepTime = this.sleepTimeMap.get(queueName) || this.sleepTime
        if (sleepTime > 0)
          await sleep(sleepTime)
      }
    }

    this.processing.delete(queueName)
  }

  private async processMessage(queueName: string, message: Message, handlers: MessageHandler<any>[]) {
    await this.redis.hset(`${queueName}:inProgress`, message.id, stringify(message))
    await this.redis.expire(`${queueName}:inProgress`, this.ttl)

    let processed = false
    for (const handler of handlers) {
      try {
        await handler(message.payload)
        await this.acknowledgeMessage(queueName, message.id)
        await this.redis.hdel(`${queueName}:failed`, message.id)
        // remove retries
        await this.redis.hdel(`${queueName}:retries`, `${queueName}:${message.id}`)
        processed = true
        break
      }
      catch (log) {
        logger.log(`[QUEUE - ${queueName}] Error processing message ${message.id}: ${log?.toString()}, message: ${stringify(message)}`)
        await this.handleFailure(queueName, message)
      }
    }

    if (processed)
      logger.log(`[QUEUE - ${queueName}] Message ${message.id} processed successfully`)
  }

  private generateId(): string {
    return randomStr(10)
  }

  private async acknowledgeMessage(queueName: string, messageId: string) {
    await this.redis.hdel(`${queueName}:inProgress`, messageId)
  }

  private async handleFailure(queueName: string, message: Message) {
    const retryKey = `${queueName}:${message.id}`
    const retries = await this.redis.hincrby(`${queueName}:retries`, retryKey, 1)
    await this.redis.expire(`${queueName}:retries`, this.ttl)

    if (retries <= this.maxRetries) {
      const messageStr = stringify(message)
      await this.redis.zadd(queueName, message.priority, messageStr)
    }
    else {
      logger.log(`[QUEUE - ${queueName}] Message ${message.id} failed after ${this.maxRetries} retries`)
      await this.acknowledgeMessage(queueName, message.id)
      await this.redis.hset(`${queueName}:failed`, message.id, stringify(message))
    }
  }

  async resumeUnprocessedTasks(queueName: string) {
    const inProgressMessages = await this.redis.hgetall(`${queueName}:inProgress`)
    for (const [, messageStr] of Object.entries(inProgressMessages)) {
      const message: Message = JSON.parse(messageStr)
      await this.handleFailure(queueName, message)
    }
  }

  async loadAllUnprocessedTasks(queueName: string) {
    const inProgressMessages = await this.redis.hgetall(`${queueName}:inProgress`)
    for (const [messageId, messageStr] of Object.entries(inProgressMessages)) {
      const message: Message = JSON.parse(messageStr)
      await this.redis.zadd(queueName, message.priority, stringify(message))
      await this.redis.hdel(`${queueName}:inProgress`, messageId)
    }
    this.processQueue(queueName)
  }

  async getFailedTasks(queueName: string) {
    return await this.redis.hgetall(`${queueName}:failed`)
  }

  async retryFailedTask(queueName: string, messageId: Message['id']) {
    const messageStr = await this.redis.hget(`${queueName}:failed`, messageId)
    if (messageStr) {
      const message: Message = JSON.parse(messageStr)
      await this.redis.hdel(`${queueName}:failed`, messageId)
      await this.redis.zadd(queueName, message.priority, messageStr)
      this.processQueue(queueName)
    }
  }

  async removeFailedTask(queueName: string, messageId: Message['id']) {
    await this.redis.hdel(`${queueName}:failed`, messageId)
  }
}

export default MessageQueue
