import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { CatalogMod } from '@shared/types'
import { api, formatBytes, formatDate } from '../api'
import { useApp } from '../state/store'
import { useT } from '../lib/i18n'
import { Badge, Button, Empty, ErrorNote, Loading, Rank, Search, useAsync } from '../components/ui'
import { ManualInstall, ModDetail } from './BrowseDetail'
import { GameChip } from '../components/GamePicker'
import { gameDefinition, type GameKind } from '@shared/games'
import { Icon } from '../components/icons'
import { itemVariants, listVariants } from '../lib/motion'

type Sort = 'rating' | 'updated' | 'title' | 'author'

/** Cards per page. Enough to fill a window, few enough to stay instant. */
const PAGE_SIZE = 36

/** Waits for a pause in typing before letting a value through. */
function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return settled
}

export function BrowseScreen(): JSX.Element {
  const t = useT()
  const { profile, game, settings, pushToast, setPlan, setPlanBusy, planBusy, setScreen } = useApp()
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('All')
  const [sort, setSort] = useState<Sort>('rating')
  // MixMods is a blog too: its news and articles have nothing to install.
  const [includeArticles, setIncludeArticles] = useState(false)
  const [detail, setDetail] = useState<CatalogMod | null>(null)
  const [manual, setManual] = useState<CatalogMod | null>(null)

  /**
   * The catalogue holds thousands of mods. Rendering them all at once is what
   * made this screen crawl, so it arrives a page at a time and the next page is
   * fetched when the end of the list comes into view.
   */
  const [mods, setMods] = useState<CatalogMod[]>([])
  const [total, setTotal] = useState(0)
  const [categories, setCategories] = useState<string[]>(['All'])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sentinel = useRef<HTMLDivElement | null>(null)

  // A keystroke should not start a query: typing "vehfuncs" would start eight.
  const query = useDebounced(search, 180)

  const loadPage = useCallback(
    async (offset: number) => {
      const page = await api.catalog({ search: query, category, sort, includeArticles, limit: PAGE_SIZE, offset })
      setCategories(page.categories)
      setTotal(page.total)
      setMods((current) => (offset === 0 ? page.mods : [...current, ...page.mods]))
    },
    [query, category, sort, includeArticles]
  )

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    loadPage(0)
      .catch((e) => {
        if (!cancelled) setError((e as Error).message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [loadPage])

  useEffect(() => {
    const node = sentinel.current
    if (!node) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return
        setMods((current) => {
          if (current.length >= total || loadingMore) return current
          setLoadingMore(true)
          void loadPage(current.length)
            .catch(() => undefined)
            .finally(() => setLoadingMore(false))
          return current
        })
      },
      // Start fetching before the user reaches the bottom, so the list does not
      // visibly stop.
      { rootMargin: '600px' }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [loadPage, total, loadingMore])

  const catalog = {
    data: { mods, categories, total },
    loading,
    error,
    reload: () => void loadPage(0)
  }
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

  return (
    <>
      <div className="page-head">
        <p>{t('browse.intro')}</p>
      </div>

      <div className="row wrap" style={{ marginBottom: 14 }}>
        <Search value={search} onChange={setSearch} placeholder={t('browse.searchPlaceholder')} width={290} />
        <select className="select" style={{ width: 168 }} value={category} onChange={(e) => setCategory(e.target.value)}>
          {(catalog.data?.categories ?? ['All']).map((c) => (
            <option key={c} value={c}>
              {c === 'All' ? t('browse.allCategories') : c}
            </option>
          ))}
        </select>
        <select className="select" style={{ width: 196 }} value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          <option value="rating">{t('browse.sortRating')}</option>
          <option value="updated">{t('browse.sortUpdated')}</option>
          <option value="title">{t('browse.sortTitle')}</option>
          <option value="author">{t('browse.sortAuthor')}</option>
        </select>
        <Button
          size="sm"
          variant={includeArticles ? 'accent' : 'default'}
          onClick={() => setIncludeArticles((v) => !v)}
          title={t('browse.articlesHint')}
        >
          {t('browse.articlesToggle')}
        </Button>
        <span className="spacer" />
        <span className="faint">
          {seed.data ? t('browse.indexedCount', { count: seed.data.count }) : ''}
          {seed.data?.lastCrawl
            ? t('browse.crawledAt', { date: formatDate(seed.data.lastCrawl) })
            : t('browse.offlineSeed')}
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
          {settings?.crawlEnabled ? t('browse.indexMixMods') : t('browse.enableIndexing')}
        </Button>
      </div>

      {catalog.error ? (
        <ErrorNote message={catalog.error} onRetry={catalog.reload} />
      ) : catalog.loading ? (
        <Loading label={t('browse.readingCatalog')} />
      ) : mods.length === 0 ? (
        <Empty
          title={t('browse.nothingMatches')}
          hint={t('browse.nothingMatchesHint')}
          action={
            <Button size="sm" onClick={() => setSearch('')}>
              {t('browse.clearSearch')}
            </Button>
          }
        />
      ) : (
        <motion.div className="grid cards" variants={listVariants} initial="initial" animate="animate">
          {mods.map((m) => (
            /*
             * No layout animation here: with a list that grows as you scroll,
             * `layout` makes every card on screen re-measure on each page, which
             * is most of what made this screen stutter. The staggered fade-in is
             * kept - it costs nothing and only runs once per card.
             */
            <motion.article key={m.id} className="card pad col" variants={itemVariants} style={{ gap: 11 }}>
              <div className="row between top">
                <div style={{ minWidth: 0 }}>
                  <strong className="ellipsis">{m.title}</strong>
                  <div className="faint ellipsis">
                    {m.author} · {m.category}
                  </div>
                </div>
                <div className="col" style={{ gap: 4, alignItems: 'flex-end' }}>
                  {m.installed ? <Badge tone="ok">{t('browse.installedBadge')}</Badge> : null}
                  {m.paywalled ? <Badge tone="warn">{t('browse.earlyAccessBadge')}</Badge> : null}
                  {m.installed?.updateAvailable ? <Badge tone="accent">{t('browse.updateBadge')}</Badge> : null}
                  {/* A catalogue row indexed before the games column existed carries
                      none, so never assume the array is there. */}
                  {games(m).length > 1 || (game && !games(m).includes(game.kind)) ? (
                    <span className="row wrap" style={{ gap: 3, justifyContent: 'flex-end' }}>
                      {games(m).map((k) => (
                        <GameChip key={k} kind={k} title={t('browse.gameChipTitle', { game: gameDefinition(k).name })} />
                      ))}
                    </span>
                  ) : null}
                </div>
              </div>

              <Rank value={m.rating} />

              <p className="faint" style={{ margin: 0, maxHeight: 54, overflow: 'hidden' }}>
                {m.description.slice(0, 200)}
              </p>

              <div className="row wrap" style={{ marginTop: 'auto' }}>
                <Button size="sm" variant="primary" disabled={!profile || planBusy} onClick={() => void install(m)}>
                  {m.installed ? t('browse.reinstall') : m.paywalled || !m.versions[0]?.downloadUrl ? t('browse.installEllipsis') : t('browse.install')}
                </Button>
                <Button size="sm" variant="quiet" onClick={() => setDetail(m)}>
                  {t('app.details')}
                </Button>
                <span className="spacer" />
                <Button
                  size="sm"
                  variant="quiet"
                  iconOnly
                  aria-label={t('browse.openMixModsPage')}
                  title={t('browse.openMixModsPage')}
                  onClick={() => void api.openExternal(m.sourceUrl)}
                  icon={<Icon.external />}
                />
              </div>
            </motion.article>
          ))}
        </motion.div>
      )}

      {mods.length > 0 ? (
        <div ref={sentinel} className="row" style={{ justifyContent: 'center', padding: '18px 0 4px' }}>
          <span className="faint num">
            {loadingMore
              ? t('browse.loadingMore')
              : mods.length >= total
                ? t('browse.allShown', { count: total })
                : t('browse.showingSome', { shown: mods.length, total })}
          </span>
        </div>
      ) : null}

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

/** The games a catalogue row is for, tolerating a row that has none recorded. */
function games(mod: CatalogMod): GameKind[] {
  return Array.isArray(mod.games) ? mod.games : []
}
