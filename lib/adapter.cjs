'use strict'

// Адаптер провайдера: переводит вызов харнесса в запрос к шлюзу.
//
// Адаптер создаётся НА КАЖДОГО провайдера. Внутри он отличается только
// идентификатором маршрута: форма запроса и разбор ответа одинаковы, потому
// что шлюз приводит всех провайдеров к одному протоколу.
//
// ЧТО ЗДЕСЬ ЕСТЬ И ЧЕГО НЕТ. Есть перевод сообщений и разбор потока — это
// работа клиентской стороны. Нет подмены заголовков, ключей и транспорта: этим
// занимается демон, и дублировать это в плагине значило бы иметь два места, где
// одно и то же решение принимается по-разному.

const { BASE, headers } = require('./daemon.cjs')

// Умолчания для моделей, о которых шлюз не сообщил метаданных.
//
// Модель без метаданных ВСЁ РАВНО РАБОТАЕТ: она просто теряет точные пределы.
// Отвергать её было бы хуже — оператор увидел бы, что модель есть в каталоге
// демона, но выбрать её не может.
const DEFAULT_CONTEXT_WINDOW = 200000
const DEFAULT_MAX_TOKENS = 32000
const DEFAULT_REASONING = 'high'

// EFFORT_NAMES — читаемые имена уровней рассуждения.
const EFFORT_NAMES = {
  off: 'Выкл', none: 'Выкл', minimal: 'Минимум', low: 'Малый',
  medium: 'Средний', high: 'Высокий', xhigh: 'Очень высокий', max: 'Максимум',
}

// DEFAULT_EFFORTS — лестница для моделей, не объявивших свою. Совпадает с той,
// что использует клиент opencode.
const DEFAULT_EFFORTS = ['off', 'low', 'high', 'max']

// createAdapter создаёт адаптер для одного провайдера.
function createAdapter(ctx, provider) {
  return new RouterAdapter(ctx, provider)
}

// RouterAdapter — адаптер провайдера через шлюз.
class RouterAdapter {
  constructor(ctx, provider) {
    this.ctx = ctx
    this.provider = provider
  }

  // providerInfo описывает маршрут для интерфейса.
  providerInfo(id) {
    return { id, name: `Free AI (${id})` }
  }

  // imageRequestPricing сообщает, что провайдер не берёт плату за изображения.
  //
  // Метод обязателен: измеритель токенов вызывает его без проверки наличия, и
  // его отсутствие сломало бы учёт.
  imageRequestPricing() { return undefined }

  // providerRetryPolicy описывает, что харнесс вправе повторить сам.
  //
  // ПОЛИТИКА ВОЗВРАЩАЕТСЯ РАЗРЕШЁННОЙ, А НЕ ОПИСАТЕЛЬНОЙ: харнесс берёт её
  // как есть и умолчания не достраивает. Вложенная форма, где backoff лежит
  // отдельным объектом, читается как отсутствие полей — паузы становятся NaN,
  // а повторы вырождаются в немедленную серию. Поэтому паузы разложены на
  // верхнем уровне.
  //
  // Повторяются только отказы, считающиеся временными. Отказ по политике
  // сервиса (например 403 на бесплатном уровне) в список не входит: это
  // устойчивое решение провайдера, и повторять его значило бы стучаться в
  // закрытую дверь.
  //
  // Метод обязателен: харнесс вызывает его на каждом маршруте без проверки
  // наличия, и его отсутствие роняет регистрацию целиком.
  providerRetryPolicy() {
    return {
      mode: 'normal',
      maxRetries: 5,
      retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'],
      backoff: { initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 },
    }
  }

  // listModels возвращает каталог провайдера.
  //
  // Список берётся у шлюза: он единственный, кто знает, что доступно прямо
  // сейчас. При недоступном шлюзе возвращается пустой список — селектор
  // покажет маршрут без моделей, а не упадёт.
  async listModels(id = this.provider) {
    const response = await fetch(`${BASE}/v1/models`, { headers: headers(false) })
    if (!response.ok) throw new Error(`GET /v1/models → HTTP ${response.status}`)
    const body = await response.json()
    const data = Array.isArray(body?.data) ? body.data : []

    const prefix = `${id}/`
    return data
      .filter((item) => typeof item?.id === 'string' && item.id.startsWith(prefix))
      .map((item) => this.modelInfo(item.id.slice(prefix.length)))
  }

  // resolveModel возвращает метаданные модели.
  //
  // Модель, которой нет в каталоге, разрешается с умолчаниями: отвергать её
  // здесь значило бы расходиться со шлюзом, который её уже принял.
  async resolveModel(provider, model) {
    return this.modelInfo(model, provider)
  }

  // prepareCall связывает метаданные модели с вызовом.
  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model),
      stream: (options) => this.stream(options),
    }
  }

  // modelInfo собирает метаданные модели.
  //
  // Точных пределов здесь нет: их знает шлюз, и он же применяет их к запросу.
  // Плагину они нужны только для интерфейса, поэтому берутся консервативными —
  // занизить оценку безопаснее, чем завысить.
  modelInfo(id, provider = this.provider) {
    return {
      provider,
      id,
      name: id,
      context: { contextWindow: DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
      inputModalities: ['text'],
      reasoning: {
        efforts: DEFAULT_EFFORTS.map((effort) => ({
          id: effort,
          name: EFFORT_NAMES[effort] || effort,
        })),
        defaultEffort: DEFAULT_REASONING,
      },
    }
  }

  // stream отправляет запрос и разбирает поток.
  async *stream(options) {
    const { createStreamer } = require('./stream.cjs')
    yield* createStreamer(this, options)
  }
}

module.exports = { createAdapter, RouterAdapter, DEFAULT_EFFORTS, EFFORT_NAMES }
