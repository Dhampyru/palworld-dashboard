import { Footer, Layout, Navbar } from 'nextra-theme-docs'
import { getPageMap } from 'nextra/page-map'

const navbar = <Navbar logo={<b>Palworld Server Dashboard</b>} projectLink="https://github.com/RNZ01/palworld-server-dashboard" />
const footer = <Footer>MIT {new Date().getFullYear()} © Palworld Server Dashboard.</Footer>

export default async function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <Layout
      navbar={navbar}
      pageMap={await getPageMap('/docs')}
      docsRepositoryBase="https://github.com/RNZ01/palworld-server-dashboard/tree/main"
      footer={footer}
      sidebar={{ defaultMenuCollapseLevel: 1 }}
    >
      {children}
    </Layout>
  )
}
