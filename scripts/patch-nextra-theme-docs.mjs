import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const file = 'node_modules/nextra-theme-docs/dist/layout.js'

if (!existsSync(file)) {
  process.exit(0)
}

const source = readFileSync(file, 'utf8')
const broken = 'LayoutPropsSchema.safeParse(themeConfig)'
const fixed = 'LayoutPropsSchema.safeParse({ ...themeConfig, children })'

if (source.includes(fixed)) {
  process.exit(0)
}

if (!source.includes(broken)) {
  console.warn('[patch-nextra-theme-docs] layout signature changed; patch skipped')
  process.exit(0)
}

writeFileSync(file, source.replace(broken, fixed))
console.log('[patch-nextra-theme-docs] patched Layout children validation')
