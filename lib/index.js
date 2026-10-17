'use strict'

// free-ai-router-plugin — доступ к бесплатным AI-провайдерам через локальный
// шлюз free-ai-router.
//
// ЧТО ИЗМЕНИЛОСЬ ПО СРАВНЕНИЮ С ПРЕЖНИМ ПЛАГИНОМ. Раньше плагин знал одного
// провайдера и регистрировал один маршрут. Теперь он спрашивает список у
// демона и регистрирует КАЖДОГО провайдера отдельным маршрутом: в селекторе
// моделей появляются все, и переключение между ними не требует правки кода.
//
// ЧТО ПЛАГИН НЕ ДЕЛАЕТ. Он не подменяет форму запроса, не хранит ключи и не
// решает, какой транспорт использовать. Всё это — работа демона. Плагин
// переводит вызов харнесса в запрос к шлюзу и переводит ответ обратно. Такое
// разделение означает, что новый провайдер появляется без выпуска плагина:
// достаточно секции в конфигурации демона.

const { listProviders, ping, BASE, headers } = require('./daemon.cjs')
const { createAdapter } = require('./adapter.cjs')

const name = 'free-ai-router-plugin'
const inject = ['llm']

// DEFAULT_PROVIDER — маршрут, доступный до того, как шлюз ответил.
//
// Плагин обязан зарегистрировать хотя бы что-то при запуске: демон может быть
// ещё не поднят, а маршрут в селекторе нужен сразу. Этот маршрут работает и
// потом — как обычный.
const DEFAULT_PROVIDER = 'opencode'

// apply регистрирует маршруты и запускает фоновое обновление списка.
function apply(ctx, config = {}) {
  const registered = new Set()

  const register = (provider) => {
    if (registered.has(provider)) return
    registered.add(provider)
    ctx.llm.registerAdapter([provider], createAdapter(ctx, provider))
  }

  // Первый маршрут регистрируется сразу, не дожидаясь шлюза: иначе при
  // недоступном демоне селектор моделей оказался бы пуст, и оператор не понял
  // бы, что именно не так.
  register(DEFAULT_PROVIDER)

  // Остальные подтягиваются из шлюза. Это фоновая задача: её неудача не должна
  // мешать запуску харнесса.
  refresh(ctx, register).catch((error) => {
    ctx.logger.warn(
      '%s: не удалось получить список провайдеров с %s (%s); зарегистрирован только %s',
      name, BASE, String(error?.message ?? error), DEFAULT_PROVIDER,
    )
  })

  // Если шлюз появится позже, список обновится сам: держать харнесс
  // из-за порядка запуска не нужно.
  ctx.effect(() => {
    const timer = setInterval(() => {
      refresh(ctx, register).catch(() => {})
    }, 30000)
    return () => clearInterval(timer)
  }, 'free-ai-router-plugin:refresh')
}

// refresh спрашивает каталог и регистрирует найденных провайдеров.
async function refresh(ctx, register) {
  const byProvider = await listProviders()
  for (const provider of byProvider.keys()) {
    register(provider)
  }
  ctx.logger.info('%s: провайдеров доступно — %d (%s)',
    name, byProvider.size, [...byProvider.keys()].join(', ') || 'ни одного')
}

module.exports = { apply, inject, name, DEFAULT_PROVIDER, ping, headers, BASE }
