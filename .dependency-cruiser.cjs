// ============================================================
// 架构依赖检查规则（Spec 034）
// 对应 project_memory 硬约束：分层依赖只能自上而下
// 运行：npm run arch:check
// ============================================================

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // 1. Domain 层不得依赖 Infrastructure（project_memory 硬约束）
    {
      name: 'domain-no-infra',
      comment: 'Domain 层不得 import Infrastructure（LanceDB/SQLite/OpenAI/fs）',
      severity: 'error',
      from: { path: '^src/domain/' },
      to: { path: '^src/infrastructure/' },
    },
    // 2. Domain 层不得依赖 Application（依赖只能自上而下）
    {
      name: 'domain-no-application',
      comment: 'Domain 层不得 import Application（依赖方向：Application → Domain）',
      severity: 'error',
      from: { path: '^src/domain/' },
      to: { path: '^src/application/' },
    },
    // 3. Application 层不得依赖 Infrastructure
    {
      name: 'application-no-infra',
      comment: 'Application 层不得 import Infrastructure，配置经 Port 由 Composition 注入',
      severity: 'error',
      from: { path: '^src/application/' },
      to: { path: '^src/infrastructure/' },
    },
    // 4. Presentation (app) 不得直接依赖 Infrastructure（必须经 composition/container）
    {
      name: 'presentation-no-infra',
      comment: 'Presentation 层不得直接 import Infrastructure，必须经 getContainer() 取 Use Case',
      severity: 'error',
      from: { path: '^src/app/' },
      to: { path: '^src/infrastructure/' },
    },
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.json' },
    exclude: {
      path: '^(test|scripts|spec|\\.next|node_modules)/',
    },
    doNotFollow: {
      path: 'node_modules',
    },
  },
};
