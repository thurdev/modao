import type { Transition, Variants } from 'motion/react'

/**
 * Motion vocabulary for Modão.
 *
 * This is a tool, not a showreel: motion exists to show where something came
 * from and that the app is responding. Everything is short, spatially small,
 * and interruptible. Nothing bounces, nothing rotates, nothing fades a value
 * the user is trying to read.
 */

/** UI-standard easing: fast out, settle in. */
export const EASE = [0.2, 0, 0, 1] as const

export const snappy: Transition = { duration: 0.16, ease: EASE }
export const smooth: Transition = { duration: 0.24, ease: EASE }
export const springy: Transition = { type: 'spring', stiffness: 520, damping: 34, mass: 0.7 }

/** Screen change: a short rise, never a slide across the whole viewport. */
export const screenVariants: Variants = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0, transition: smooth },
  exit: { opacity: 0, y: -4, transition: snappy }
}

/** Lists and grids: a small stagger so the eye can follow the order. */
export const listVariants: Variants = {
  initial: {},
  animate: { transition: { staggerChildren: 0.022, delayChildren: 0.02 } },
  exit: {}
}

export const itemVariants: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: smooth },
  exit: { opacity: 0, transition: snappy }
}

/** Dialogs scale from almost-full-size: a hint of arrival, not a zoom. */
export const modalVariants: Variants = {
  initial: { opacity: 0, scale: 0.985, y: 8 },
  animate: { opacity: 1, scale: 1, y: 0, transition: { duration: 0.2, ease: EASE } },
  exit: { opacity: 0, scale: 0.99, y: 4, transition: snappy }
}

export const scrimVariants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: snappy },
  exit: { opacity: 0, transition: snappy }
}

export const toastVariants: Variants = {
  initial: { opacity: 0, x: 16, scale: 0.98 },
  animate: { opacity: 1, x: 0, scale: 1, transition: springy },
  exit: { opacity: 0, x: 12, transition: snappy }
}

export const collapseVariants: Variants = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1, transition: smooth },
  exit: { height: 0, opacity: 0, transition: snappy }
}

/** True when the OS asks for reduced motion; callers drop transforms, never feedback. */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
