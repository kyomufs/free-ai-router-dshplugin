'use strict'

// Общение с демоном free-ai-router.
//
// Всё, что плагин знает о шлюзе, собрано здесь: адрес, токен, список
// провайдеров и моделей. Остальной код плагина работает с уже разрешёнными
// значениями и о транспорте не знает.

// BASE — адрес шлюза БЕЗ пути: плагин сам дописывает /v1/... Путь в константе
// приводил бы к двойному префиксу при смене версии API.
const BASE = process.env.FREE_AI_ROUTER_BASE || 'http://127.0.0.1:8787'

// TOKEN — общий секрет для режима server.
//
// Это ДРУГОЙ секрет, нежели ключ провайдера. Ключ открывает доступ к сервису,
// токен — к нашему шлюзу. Смешав их, мы либо отправили бы ключ провайдера
// наружу, либо предъявили наш токен чужому сервису.
//
// Пустое значение — норма для режима local: до loopback-слушателя кроме этой
// машины никто не дотянется, и токен не проверяется.
const TOKEN = process.env.FREE_AI_ROUTER_TOKEN || ''

// Тайм-аут чтения каталога. Каталог нужен для регистрации маршрутов, но его
// отсутствие не должно задерживать запуск: плагин зарегистрирует то, что уже
// знает.
const CATALOG_TIMEOUT_MS = 2000

// headers собирает заголовки запроса к шлюзу.
//
// Токен отправляется и на чтение каталога: без него шлюз в режиме server
// отвечает отказом, и удалённое развёртывание оказывается «подключаемым, но
// неработающим».
function headers(json) {
  const out = {}
  if (json) out['content-type'] = 'application/json'
  if (TOKEN) out.authorization = `Bearer ${TOKEN}`
  return out
}

// listProviders спрашивает у шлюза каталог моделей.
//
// Возвращает карту «провайдер → модели». Пустая карта означает, что шлюз
// недоступен: это НЕ ошибка запуска, а обычное состояние, когда демон ещё не
// поднят.
async function listProviders() {
  const response = await fetch(`${BASE}/v1/models`, {
    headers: headers(false),
    signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`GET /v1/models → HTTP ${response.status}`)

  const body = await response.json()
  const data = Array.isArray(body?.data) ? body.data : []

  // Идентификатор модели составной: "провайдер/модель". Разделение идёт по
  // ПЕРВОМУ слэшу, потому что идентификаторы самих моделей слэши содержат
  // (например "poolside/laguna-s-2.1:free").
  const byProvider = new Map()
  for (const item of data) {
    if (!item || typeof item.id !== 'string') continue
    const slash = item.id.indexOf('/')
    if (slash <= 0) continue

    const provider = item.id.slice(0, slash)
    const model = item.id.slice(slash + 1)
    if (!byProvider.has(provider)) byProvider.set(provider, [])
    byProvider.get(provider).push(model)
  }
  return byProvider
}

// ping проверяет доступность шлюза.
async function ping() {
  try {
    const response = await fetch(`${BASE}/_control/status`, {
      headers: headers(false),
      signal: AbortSignal.timeout(1500),
    })
    return response.ok
  } catch {
    return false
  }
}

module.exports = { BASE, TOKEN, headers, listProviders, ping }
