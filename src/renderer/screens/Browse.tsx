import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { CatalogMod } from '@shared/types'
import { api, formatBytes, formatDate } from '../api'
import { useApp } from '../state/store'
import { Badge, Button, Empty, ErrorNote, Loading, Rank, Search, useAsync } from '../components/ui'
import { ManualInstall, ModDetail } from './BrowseDetail'
import { Icon } from '../components/icons'
import { itemVariants, listVariants } from '../lib/motion'

type Sort = 'rating' | 'updated' | 'title' | 'author'

export function BrowseScreen(): JSX.Element {
  const { profile, settings, pushToast, setPlan, setPlanBusy, planBusy, setScreen } = useApp()
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('All')
  const [sort, setSort] = useState<Sort>('rating')
  const [detail, setDetail] = useState<CatalogMod | null>(null)
  const [manual, setManual] = useState<CatalogMod | null>(null)

  const catalog = useAsync(() => api.catalog({ search, category, sort }), [search, category, sort])
  const seed = useAsync(() => api.seedInfo(), [])

  /**
   * MixMods hosts most files on sharemods, MediaFire or Patreon, and some
   * releases are early access. When there is no direct link Modão can fetch,
   * the install does not just fail: the user is walked through downloading it
   * themselves and handing the archive back, which lands in the same plan
   * dialog with the same file-level preview.
   */
  async function install(mod: CatalogMod): Promise<void> {
    if (!profile) return
    const version = mod.versions[0]
    // Paywalled builds are the one thing Modão will not fetch. Everything
    // else is attempted automatically - including the file hosts that only
    // serve browsers - and only falls back to the manual route if that fails.
    if (!version || !version.downloadUrl || mod.paywalled) {
      setManual(mod)
      return
    }
    setPlanBusy(true)
    try {
      setPlan(await api.planFromCatalog(version.id, profile.id))
    } catch (e) {
      pushToast('error', (e as Error).message)
      setManual(mod)
    } finally {
      setPlanBusy(false)
    }
  }

  async function installFromFile(): Promise<void> {
    if (!profile) return
    setPlanBusy(true)
    try {
      const plan = await api.planFromFile(profile.id)
      if (plan) setPlan(plan)
      setManual(null)
    } catch (e) {
      pushToast('error', (e as Error).message)
    } finally {
      setPlanBusy(false)
    }
  }

  const mods = catalog.data?.mods ?? []

  return (
    <>
      <div className="page-head">
        <p>
          A discovery client for MixMods, not a mirror. Pages are cached locally and re-read at most once a day, one
          request per second, honouring robots.txt. Paywalled early-access releases link to the author&apos;s own page
          and are never downloaded here.
        </p>
      </div>

      <div className="row wrap" style={{ marginBottom: 14 }}>
        <Search value={search} onChange={setSearch} placeholder="Search title, author or description…" width={290} />
        <select className="select" style={{ width: 168 }} value={category} onChange={(e) => setCategory(e.target.value)}>
          {(catalog.data?.categories ?? ['All']).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select className="select" style={{ width: 196 }} value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          <option value="rating">Synthesised ranking</option>
          <option value="updated">Recently updated</option>
          <option value="title">Title</option>
          <option value="author">Author</option>
        </select>
        <span className="spacer" />
        <span className="faint">
          {seed.data ? `${seed.data.count} indexed` : ''}
          {seed.data?.lastCrawl ? ` · crawled ${formatDate(seed.data.lastCrawl)}` : ' · offline seed'}
        </span>
        <Button
          size="sm"
          icon={<Icon.download width={13} height={13} />}
          onClick={async () => {
            const r = await api.crawl()
            if (!r.started) {
              pushToast('error', r.message)
              setScreen('settings')
              return
            }
            pushToast('info', r.message)
          }}
        >
          {settings?.crawlEnabled ? 'Index MixMods' : 'Enable indexing…'}
        </Button>
      </div>

      {catalog.error ? (
        <ErrorNote message={catalog.error} onRetry={catalog.reload} />
      ) : catalog.loading ? (
        <Loading label="Reading the catalog…" />
      ) : mods.length === 0 ? (
        <Empty
          title="Nothing matches"
          hint="Try a different search, or index MixMods from Settings to pull in more pages."
          action={
            <Button size="sm" onClick={() => setSearch('')}>
              Clear search
            </Button>
          }
        />
      ) : (
        <motion.div className="grid cards" variants={listVariants} initial="initial" animate="animate">
          {mods.map((m) => (
            <motion.article key={m.id} className="card pad col" variants={itemVariants} layout style={{ gap: 11 }}>
              <div className="row between top">
                <div style={{ minWidth: 0 }}>
                  <strong className="ellipsis">{m.title}</strong>
                  <div className="faint ellipsis">
                    {m.author} · {m.category}
                  </div>
                </div>
                <div className="col" style={{ gap: 4, alignItems: 'flex-end' }}>
                  {m.installed ? <Badge tone="ok">installed</Badge> : null}
                  {m.paywalled ? <Badge tone="warn">early access</Badge> : null}
                  {m.installed?.updateAvailable ? <Badge tone="accent">update</Badge> : null}
                </div>
              </div>

              <Rank value={m.rating} />

              <p className="faint" style={{ margin: 0, maxHeight: 54, overflow: 'hidden' }}>
                {m.description.slice(0, 200)}
              </p>

              <div className="row wrap" style={{ marginTop: 'auto' }}>
                <Button size="sm" variant="primary" disabled={!profile || planBusy} onClick={() => void install(m)}>
                  {m.installed ? 'Reinstall' : m.paywalled || !m.versions[0]?.downloadUrl ? 'Install…' : 'Install'}
                </Button>
                <Button size="sm" variant="quiet" onClick={() => setDetail(m)}>
                  Details
                </Button>
                <span className="spacer" />
                <Button
                  size="sm"
                  variant="quiet"
                  iconOnly
                  aria-label="Open the MixMods page"
                  title="Open the MixMods page"
                  onClick={() => void api.openExternal(m.sourceUrl)}
                  icon={<Icon.external />}
                />
              </div>
            </motion.article>
          ))}
        </motion.div>
      )}

      <AnimatePresence>
        {manual ? (
          <ManualInstall
            key={`manual-${manual.id}`}
            mod={manual}
            busy={planBusy}
            onPick={installFromFile}
            onClose={() => setManual(null)}
          />
        ) : null}
        {detail ? (
          <ModDetail
            key={detail.id}
            mod={detail}
            onInstall={() => {
              void install(detail)
              setDetail(null)
            }}
            onClose={() => setDetail(null)}
          />
        ) : null}
      </AnimatePresence>
    </>
  )
}
