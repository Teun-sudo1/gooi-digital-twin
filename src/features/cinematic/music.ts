import { useEffect, useRef, useState } from 'react'

/*
 * Lofi music for cinematic mode: the album "Lo-Fi and Chill" by Holizna,
 * dedicated to the public domain (CC0) and published on OpenGameArt
 * (https://opengameart.org/node/161819). The files in public/music are the
 * originals re-encoded to 96 kbps AAC. The tracks play shuffled, one after
 * another, fading in at the start and out at the end of cinematic mode.
 */

export interface Track {
  title: string
  file: string
}

export const ARTIST = 'Holizna'
export const MUSIC_SOURCE = 'https://opengameart.org/node/161819'

export const TRACKS: Track[] = [
  { title: 'First Snow', file: 'first-snow.m4a' },
  { title: 'Laundry On The Wire', file: 'laundry-on-the-wire.m4a' },
  { title: 'Everything You Ever Dreamed', file: 'everything-you-ever-dreamed.m4a' },
  { title: 'Keeping Cool', file: 'keeping-cool.m4a' },
  { title: 'Snow Drift', file: 'snow-drift.m4a' },
  { title: 'Windows Down', file: 'windows-down.m4a' },
  { title: '2 Hour Delay', file: '2-hour-delay.m4a' },
]

const VOLUME_KEY = 'gooi-music-volume'
const FADE_IN = 2500
const FADE_OUT = 1200

function storedVolume() {
  try {
    const value = Number(window.localStorage.getItem(VOLUME_KEY))
    return value > 0 && value <= 1 ? value : 0.6
  } catch {
    return 0.6
  }
}

function shuffled<T>(items: T[]) {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** Ramps an element's volume to `to` over `ms` (on a timer, so it also runs in a background tab); returns a function that cancels it. */
function fade(audio: HTMLAudioElement, to: number, ms: number, done?: () => void) {
  const from = audio.volume
  const start = performance.now()
  const timer = window.setInterval(() => {
    const t = Math.min(1, (performance.now() - start) / ms)
    audio.volume = from + (to - from) * t
    if (t < 1) return
    window.clearInterval(timer)
    done?.()
  }, 40)
  return () => window.clearInterval(timer)
}

export interface Music {
  track: Track | null
  /** The browser refused to start playing (no recent click): `resume` starts it. */
  blocked: boolean
  muted: boolean
  volume: number
  setVolume: (volume: number) => void
  toggleMute: () => void
  next: () => void
  resume: () => void
}

/** Plays the tracks shuffled while `on`; fades out and stops when it turns off. */
export function useMusic(on: boolean): Music {
  const audio = useRef<HTMLAudioElement | null>(null)
  const [track, setTrack] = useState<Track | null>(null)
  const [blocked, setBlocked] = useState(false)
  const [muted, setMuted] = useState(false)
  const [volume, setVolumeState] = useState(storedVolume)
  const volumeRef = useRef(volume)
  const nextRef = useRef(() => {})

  useEffect(() => {
    if (!on) return
    const element = new Audio()
    element.preload = 'auto'
    element.volume = 0
    audio.current = element
    const order = shuffled(TRACKS)
    let index = -1
    let cancelFade = () => {}
    const play = () => {
      element.play().then(
        () => setBlocked(false),
        (error: unknown) => {
          // Not allowed yet (or the file failed): wait for a click on Play music.
          if (error instanceof DOMException && error.name === 'NotAllowedError') setBlocked(true)
          else console.warn('[music]', error)
        },
      )
    }
    const next = () => {
      index = (index + 1) % order.length
      setTrack(order[index])
      element.src = `${import.meta.env.BASE_URL}music/${order[index].file}`
      play()
    }
    nextRef.current = next
    element.addEventListener('ended', next)
    next()
    cancelFade = fade(element, volumeRef.current, FADE_IN)
    return () => {
      cancelFade()
      element.removeEventListener('ended', next)
      fade(element, 0, FADE_OUT, () => {
        element.pause()
        element.removeAttribute('src')
        element.load()
      })
      audio.current = null
      nextRef.current = () => {}
      setTrack(null)
      setBlocked(false)
      setMuted(false)
    }
  }, [on])

  const setVolume = (value: number) => {
    volumeRef.current = value
    setVolumeState(value)
    if (audio.current) audio.current.volume = value
    try {
      window.localStorage.setItem(VOLUME_KEY, String(value))
    } catch {
      // Not remembered; fine.
    }
  }

  const toggleMute = () => {
    if (audio.current) audio.current.muted = !muted
    setMuted(!muted)
  }

  const resume = () => {
    audio.current?.play().then(() => setBlocked(false), () => {})
  }

  return { track, blocked, muted, volume, setVolume, toggleMute, next: () => nextRef.current(), resume }
}
