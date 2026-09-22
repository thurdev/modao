import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { CatalogMod, ModBlock } from '@shared/types'
import { classifyDownload } from '@shared/download'
import { api, formatBytes, formatDate } from '../api'
import { Badge, Button, Modal, Rank } from '../components/ui'
import { Icon } from '../components/icons'
import { useT } from '../lib/i18n'

/**
 * A mod page is a post, so it is shown as one: the author's text and their
 * screenshots in the order they wrote them, one column, set to be read. The
 * catalogue metadata sits above and below it rather than competing with it.
 */
export function ModDetail(props: { mod: CatalogMod; onClose: () => void; onInstall: () => void }): JSX.Element {
  const t = useT()
  const [fetched, setFetched] = useState<CatalogMod | null>(null)
  const [fetching, setFetching] = useState(false)
  const m = fetched ?? props.mod
  const [lightbox, setLightbox] = useState<string | null>(null)

  /**
   * The bundled index carries a summary and a link, not the author's whole
   * post - Modão is a way to find someone else's work, not a copy of it. So the
   * first time a mod is opened, the post is read from MixMods and cached
   * locally. Offline, the summary and the link stand on their own.
   */
  useEffect(() => {
    if (props.mod.blocks.length > 0 || fetching) return
    let cancelled = false
    setFetching(true)
    void api
      .refreshMod(props.mod.id)
      .then(async () => {
        if (cancelled) return
        const full = await api.catalogMod(props.mod.id)
        if (!cancelled && full) setFetched(full)
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setFetching(false)
      })
    return () => {
      cancelled = true
    }
  }, [props.mod.id, props.mod.blocks.length])
  const link = m.versions[0]?.downloadUrl ?? null
  const kind = classifyDownload(link)
  const direct = !m.paywalled && kind.direct ? link : null
  const blocks = m.blocks.length > 0 ? m.blocks : fallbackBlocks(m)

  return (
    <Modal
      title={m.title}
      subtitle={
        <>
          {m.author} · {m.category} · updated {formatDate(m.updatedAt)} ·{' '}
          <a
            href={m.sourceUrl}
            onClick={(e) => {
              e.preventDefault()
              void api.openExternal(m.sourceUrl)
            }}
          >
            {t('browse.readOnMixMods')}
          </a>
        </>
      }
      onClose={props.onClose}
      width={880}
      footer={
        <>
          <Button onClick={props.onClose}>{t('app.close')}</Button>
          <Button
            variant="quiet"
            icon={<Icon.external width={13} height={13} />}
            onClick={() => void api.openExternal(m.sourceUrl)}
          >
            {t('browse.openModPage')}
          </Button>
          <span className="spacer" />
          {m.paywalled ? <span className="faint">{t('browse.earlyAccessNotice')}</span> : null}
          <Button variant="primary" onClick={props.onInstall}>
            {direct ? t('browse.installEllipsis') : t('browse.installFromDownloadedFile')}
          </Button>
        </>
      }
    >
      <article className="post">
        <header className="post-meta">
          <span className="row wrap" style={{ gap: 7 }}>
            <Rank value={m.rating} />
            {m.paywalled ? <Badge tone="warn">{t('browse.earlyAccessBadge')}</Badge> : null}
            {m.ratingInputs.inEssentials ? <Badge tone="ok">{t('browse.essentialsPack')}</Badge> : null}
            {m.installed ? (
              <Badge tone="accent">{t('browse.installedVersion', { version: m.installed.versionLabel })}</Badge>
            ) : null}
          </span>
          <span className="spacer" />
          <span className="faint num">
            {m.versions[0]?.versionLabel ?? t('browse.unknownVersion')}
            {m.versions[0]?.fileSize ? ` · ${formatBytes(m.versions[0].fileSize)}` : ''}
            {direct ? ` · ${hostOf(direct)}` : t('browse.noDirectLink')}
          </span>
        </header>

        <div className="post-body">
          {blocks.map((b, i) => (
            <Block key={i} block={b} onZoom={setLightbox} />
          ))}
        </div>

        <footer className="post-foot">
          <div className="grid two">
            <div className="card pad col">
              <strong>{t('browse.whyRanks')}</strong>
              <p className="faint" style={{ margin: 0 }}>
                {t('browse.rankingExplain')}
              </p>
              <dl className="kv">
                <dt>{t('browse.recency')}</dt>
                <dd className="num">{(m.ratingInputs.recency * 100).toFixed(0)}%</dd>
                <dt>{t('browse.authorFootprint')}</dt>
                <dd className="num">{(m.ratingInputs.authorReputation * 100).toFixed(0)}%</dd>
                <dt>{t('browse.essentialsPack')}</dt>
                <dd>{m.ratingInputs.inEssentials ? t('browse.listedStrongSignal') : t('browse.notListed')}</dd>
                <dt>{t('browse.requiredBy')}</dt>
                <dd className="num">{t('browse.requiredByCount', { count: m.ratingInputs.requiredByCount })}</dd>
                <dt>{t('browse.localInstalls')}</dt>
                <dd className="num">{m.ratingInputs.installCount}</dd>
              </dl>
            </div>

            <div className="card pad col">
              <strong>{t('browse.release')}</strong>
              {m.versions.map((v) => (
                <div key={v.id} className="row between">
                  <span>{v.versionLabel}</span>
                  <span className="faint num">
                    {formatDate(v.releaseDate)}
                    {v.fileSize ? ` · ${formatBytes(v.fileSize)}` : ''}
                  </span>
                </div>
              ))}
              <span className="faint">
                {direct
                  ? t('browse.hostedOn', { host: hostOf(direct) })
                  : (kind.reasonKey ? t(kind.reasonKey, kind.reasonParams) : t('browse.noLinkFetchable')) + t('browse.downloadAndHandBack')}
              </span>
              {m.requirementsText.length > 0 ? (
                <>
                  <strong style={{ marginTop: 4 }}>{t('browse.statedRequirements')}</strong>
                  <ul className="muted" style={{ margin: 0, paddingLeft: 18 }}>
                    {m.requirementsText.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                </>
              ) : null}
              {m.incompatibleText.length > 0 ? (
                <>
                  <strong style={{ marginTop: 4 }}>{t('browse.statedIncompatibilities')}</strong>
                  <ul className="muted" style={{ margin: 0, paddingLeft: 18 }}>
                    {m.incompatibleText.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          </div>
        </footer>
      </article>

      <AnimatePresence>
        {lightbox ? (
          <motion.div
            className="lightbox"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setLightbox(null)}
            role="presentation"
          >
            <img src={lightbox} alt="" />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </Modal>
  )
}

function Block(props: { block: ModBlock; onZoom: (src: string) => void }): JSX.Element | null {
  const t = useT()
  const b = props.block
  if (b.type === 'heading') return <h3 className="post-h">{b.text}</h3>
  if (b.type === 'text') return <p>{b.text}</p>
  if (b.type === 'list') {
    return (
      <ul className="post-list">
        {b.items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    )
  }
  if (b.type === 'image') {
    return (
      <figure className="post-figure">
        <button onClick={() => props.onZoom(b.src)} aria-label={t('browse.enlargeScreenshot')}>
          <img src={b.src} alt={b.caption ?? ''} loading="lazy" />
        </button>
        {isRealCaption(b.caption) ? <figcaption>{b.caption}</figcaption> : null}
      </figure>
    )
  }
  if (b.type === 'video') {
    const embed = embedUrl(b.src)
    return (
      <figure className="post-video">
        {embed ? (
          <div className="post-embed">
            <iframe
              src={embed}
              title={t('browse.modVideo')}
              loading="lazy"
              allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              referrerPolicy="strict-origin-when-cross-origin"
            />
          </div>
        ) : null}
        <figcaption>
          <Button size="sm" variant="quiet" icon={<Icon.external width={12} height={12} />} onClick={() => void api.openExternal(watchUrl(b.src))}>
            {t('browse.openOnHost', { host: hostOf(b.src) })}
          </Button>
        </figcaption>
      </figure>
    )
  }
  return null
}

/**
 * Normalises whatever the post embedded into a privacy-friendly embed URL.
 * youtube-nocookie keeps the player from writing tracking cookies for someone
 * who only wanted to look at a mod.
 */
function embedUrl(src: string): string | null {
  try {
    const url = new URL(src, 'https://www.youtube.com')
    const host = url.hostname.replace(/^www\./, '')
    if (host === 'youtu.be') return `https://www.youtube-nocookie.com/embed/${url.pathname.slice(1)}`
    if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      const id = url.pathname.startsWith('/embed/') ? url.pathname.slice('/embed/'.length) : (url.searchParams.get('v') ?? '')
      return id ? `https://www.youtube-nocookie.com/embed/${id}` : null
    }
    if (host.endsWith('vimeo.com')) {
      const id = url.pathname.split('/').filter(Boolean).pop()
      return id ? `https://player.vimeo.com/video/${id}` : null
    }
    return null
  } catch {
    return null
  }
}

/** The page a viewer should land on if they click out to the site. */
function watchUrl(src: string): string {
  const embed = embedUrl(src)
  if (!embed) return src
  const id = embed.split('/').pop()
  return embed.includes('vimeo') ? `https://vimeo.com/${id}` : `https://www.youtube.com/watch?v=${id}`
}

/**
 * WordPress fills alt text with the uploaded file name ("mod-2-1867634"), which
 * is noise under a screenshot. Only a caption that reads like a sentence is
 * worth showing.
 */
function isRealCaption(caption: string | null): caption is string {
  if (!caption) return false
  const value = caption.trim()
  if (value.length < 6) return false
  if (/^[\w-]+$/.test(value)) return false
  return /\s/.test(value)
}

/** Entries indexed before the app kept page layout still have their text and images. */
function fallbackBlocks(m: CatalogMod): ModBlock[] {
  const text: ModBlock[] = m.description
    .split(/\n+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => ({ type: 'text', text: t }))
  const images: ModBlock[] = m.images.map((src) => ({ type: 'image', src, caption: null }))
  return [...text.slice(0, 3), ...images.slice(0, 2), ...text.slice(3), ...images.slice(2)]
}

/**
 * Most MixMods files live on sharemods, MediaFire or Patreon, and some releases
 * are early access. Modão will not click through a host's own page for the
 * user, and will not touch a paywall at all - so it hands over the link and
 * takes the archive back. From there the install is identical to a direct
 * download: same readme parse, same variant chooser, same file-level plan.
 */
export function ManualInstall(props: {
  mod: CatalogMod
  busy: boolean
  onPick: () => void
  onClose: () => void
}): JSX.Element {
  const t = useT()
  const m = props.mod
  const direct = m.versions[0]?.downloadUrl ?? null

  return (
    <Modal
      title={t('browse.installModTitle', { name: m.title })}
      subtitle={m.paywalled ? t('browse.earlyAccessSubtitle') : t('browse.noDirectLinkSubtitle')}
      onClose={props.onClose}
      width={640}
      footer={
        <>
          <Button onClick={props.onClose}>{t('app.cancel')}</Button>
          <span className="spacer" />
          <Button
            variant="primary"
            disabled={props.busy}
            onClick={props.onPick}
            icon={<Icon.folder width={13} height={13} />}
          >
            {props.busy ? t('browse.reading') : t('browse.chooseArchive')}
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        <p className="muted" style={{ margin: 0 }}>
          {m.paywalled
            ? t('browse.paywalledExplain')
            : reasonText(classifyDownload(direct), t, t('browse.noLinkExplainFallback')) + t('browse.downloadYourselfThenPick')}
        </p>

        <div className="col" style={{ gap: 12 }}>
          <div className="step">
            <span className="step-num">1</span>
            <div>
              <strong>{t('browse.openModPage')}</strong>
              <div className="faint mono">{m.sourceUrl}</div>
              <div className="row wrap" style={{ marginTop: 7 }}>
                <Button
                  size="sm"
                  icon={<Icon.external width={13} height={13} />}
                  onClick={() => void api.openExternal(m.sourceUrl)}
                >
                  {t('browse.openMixmodsSite')}
                </Button>
                {direct ? (
                  <Button
                    size="sm"
                    variant="quiet"
                    icon={<Icon.download width={13} height={13} />}
                    onClick={() => void api.openExternal(direct)}
                  >
                    {t('browse.goStraightTo', { host: hostOf(direct) })}
                  </Button>
                ) : null}
              </div>
            </div>
          </div>

          <div className="step">
            <span className="step-num">2</span>
            <div>
              <strong>{t('browse.downloadArchive')}</strong>
              <div className="faint">{t('browse.archiveFormats')}</div>
            </div>
          </div>

          <div className="step">
            <span className="step-num">3</span>
            <div>
              <strong>{t('browse.handItBack')}</strong>
              <div className="faint">{t('browse.handItBackExplain')}</div>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** The classifier's explanation, said in the user's language. */
function reasonText(
  kind: ReturnType<typeof classifyDownload>,
  t: (key: string, vars?: Record<string, string | number>) => string,
  fallback: string
): string {
  return kind.reasonKey ? t(kind.reasonKey, kind.reasonParams) : fallback
}
