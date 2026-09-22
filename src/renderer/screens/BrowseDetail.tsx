import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { CatalogMod, ModBlock } from '@shared/types'
import { classifyDownload } from '@shared/download'
import { api, formatBytes, formatDate } from '../api'
import { Badge, Button, Modal, Rank } from '../components/ui'
import { Icon } from '../components/icons'

/**
 * A mod page is a post, so it is shown as one: the author's text and their
 * screenshots in the order they wrote them, one column, set to be read. The
 * catalogue metadata sits above and below it rather than competing with it.
 */
export function ModDetail(props: { mod: CatalogMod; onClose: () => void; onInstall: () => void }): JSX.Element {
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
            read it on mixmods.com.br
          </a>
        </>
      }
      onClose={props.onClose}
      width={880}
      footer={
        <>
          <Button onClick={props.onClose}>Close</Button>
          <Button
            variant="quiet"
            icon={<Icon.external width={13} height={13} />}
            onClick={() => void api.openExternal(m.sourceUrl)}
          >
            Open the mod page
          </Button>
          <span className="spacer" />
          {m.paywalled ? (
            <span className="faint">Early access on the author&apos;s Patreon — Modão will not mirror it.</span>
          ) : null}
          <Button variant="primary" onClick={props.onInstall}>
            {direct ? 'Install…' : 'Install from a downloaded file…'}
          </Button>
        </>
      }
    >
      <article className="post">
        <header className="post-meta">
          <span className="row wrap" style={{ gap: 7 }}>
            <Rank value={m.rating} />
            {m.paywalled ? <Badge tone="warn">early access</Badge> : null}
            {m.ratingInputs.inEssentials ? <Badge tone="ok">Essentials pack</Badge> : null}
            {m.installed ? <Badge tone="accent">installed {m.installed.versionLabel}</Badge> : null}
          </span>
          <span className="spacer" />
          <span className="faint num">
            {m.versions[0]?.versionLabel ?? 'unknown version'}
            {m.versions[0]?.fileSize ? ` · ${formatBytes(m.versions[0].fileSize)}` : ''}
            {direct ? ` · ${hostOf(direct)}` : ' · no direct link'}
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
              <strong>Why it ranks where it does</strong>
              <p className="faint" style={{ margin: 0 }}>
                MixMods has no star rating. This score is Modão&apos;s own, from the inputs below — never a community
                score.
              </p>
              <dl className="kv">
                <dt>Recency</dt>
                <dd className="num">{(m.ratingInputs.recency * 100).toFixed(0)}%</dd>
                <dt>Author footprint</dt>
                <dd className="num">{(m.ratingInputs.authorReputation * 100).toFixed(0)}%</dd>
                <dt>Essentials pack</dt>
                <dd>{m.ratingInputs.inEssentials ? 'listed — strong signal' : 'not listed'}</dd>
                <dt>Required by</dt>
                <dd className="num">{m.ratingInputs.requiredByCount} catalog mod(s)</dd>
                <dt>Local installs</dt>
                <dd className="num">{m.ratingInputs.installCount}</dd>
              </dl>
            </div>

            <div className="card pad col">
              <strong>Release</strong>
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
                  ? `Hosted on ${hostOf(direct)} — Modão downloads it, then shows the file-level plan.`
                  : (kind.reason ?? 'No link Modão can fetch.') +
                    ' Download it from the mod page and hand the archive back; the install is identical from there.'}
              </span>
              {m.requirementsText.length > 0 ? (
                <>
                  <strong style={{ marginTop: 4 }}>Stated requirements</strong>
                  <ul className="muted" style={{ margin: 0, paddingLeft: 18 }}>
                    {m.requirementsText.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                </>
              ) : null}
              {m.incompatibleText.length > 0 ? (
                <>
                  <strong style={{ marginTop: 4 }}>Stated incompatibilities</strong>
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
        <button onClick={() => props.onZoom(b.src)} aria-label="Enlarge screenshot">
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
              title="Mod video"
              loading="lazy"
              allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              referrerPolicy="strict-origin-when-cross-origin"
            />
          </div>
        ) : null}
        <figcaption>
          <Button size="sm" variant="quiet" icon={<Icon.external width={12} height={12} />} onClick={() => void api.openExternal(watchUrl(b.src))}>
            Open on {hostOf(b.src)}
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
  const m = props.mod
  const direct = m.versions[0]?.downloadUrl ?? null

  return (
    <Modal
      title={`Install ${m.title}`}
      subtitle={
        m.paywalled
          ? 'This release is early access on the author’s Patreon'
          : 'This release has no direct link Modão can fetch'
      }
      onClose={props.onClose}
      width={640}
      footer={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <span className="spacer" />
          <Button
            variant="primary"
            disabled={props.busy}
            onClick={props.onPick}
            icon={<Icon.folder width={13} height={13} />}
          >
            {props.busy ? 'Reading…' : 'Choose the downloaded archive'}
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        <p className="muted" style={{ margin: 0 }}>
          {m.paywalled
            ? 'Modão does not mirror or bypass paywalled files. Open the mod page, support the author if you want that build, download it, and hand the archive back here.'
            : `${classifyDownload(direct).reason ?? 'That link is not a file Modão can fetch.'} Download it yourself, then pick the archive.`}
        </p>

        <div className="col" style={{ gap: 12 }}>
          <div className="step">
            <span className="step-num">1</span>
            <div>
              <strong>Open the mod page</strong>
              <div className="faint mono">{m.sourceUrl}</div>
              <div className="row wrap" style={{ marginTop: 7 }}>
                <Button
                  size="sm"
                  icon={<Icon.external width={13} height={13} />}
                  onClick={() => void api.openExternal(m.sourceUrl)}
                >
                  Open mixmods.com.br
                </Button>
                {direct ? (
                  <Button
                    size="sm"
                    variant="quiet"
                    icon={<Icon.download width={13} height={13} />}
                    onClick={() => void api.openExternal(direct)}
                  >
                    Go straight to {hostOf(direct)}
                  </Button>
                ) : null}
              </div>
            </div>
          </div>

          <div className="step">
            <span className="step-num">2</span>
            <div>
              <strong>Download the archive</strong>
              <div className="faint">A .7z, .zip or .rar — wherever your browser puts it.</div>
            </div>
          </div>

          <div className="step">
            <span className="step-num">3</span>
            <div>
              <strong>Hand it back</strong>
              <div className="faint">
                Modão decodes the readme, classifies every file, asks about variants and shows the full plan before
                writing anything.
              </div>
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
