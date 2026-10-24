import { useEffect, useRef } from 'react'
import type { Weather } from '../features/environment/environment'
import { useAppStore } from '../store/useAppStore'

/** Particles on screen per weather type. */
const PARTICLES: Partial<Record<Weather, number>> = { rain: 260, 'heavy-rain': 650, snow: 320 }

interface Particle {
  x: number
  y: number
  speed: number
  size: number
  drift: number
}

/**
 * Rain, snow and fog drawn over the map (pointer events pass through).
 * Without motion (prefers-reduced-motion) only the fog and a light tint remain.
 */
export function WeatherOverlay() {
  const weather = useAppStore((s) => s.weather)
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const el = canvas.current
    const count = PARTICLES[weather]
    if (!el || !count || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const ctx = el.getContext('2d')
    if (!ctx) return
    const snow = weather === 'snow'
    let width = 0
    let height = 0
    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio, 2)
      width = el.clientWidth
      height = el.clientHeight
      el.width = width * ratio
      el.height = height * ratio
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    }
    resize()
    const spawn = (anywhere: boolean): Particle => ({
      x: Math.random() * (width + 200) - 100,
      y: anywhere ? Math.random() * height : -20,
      speed: snow ? 30 + Math.random() * 40 : 700 + Math.random() * 500,
      size: snow ? 1.2 + Math.random() * 2.2 : 16 + Math.random() * 18,
      drift: snow ? Math.random() * Math.PI * 2 : 0,
    })
    const particles = Array.from({ length: count }, () => spawn(true))
    let last = performance.now()
    let frame = 0
    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      ctx.clearRect(0, 0, width, height)
      const dark = document.documentElement.dataset.theme === 'dark'
      ctx.strokeStyle = dark ? 'rgba(190, 210, 235, 0.5)' : 'rgba(60, 80, 110, 0.5)'
      ctx.fillStyle = dark ? 'rgba(235, 240, 248, 0.8)' : 'rgba(255, 255, 255, 0.95)'
      ctx.lineWidth = 1.3
      ctx.beginPath()
      for (const p of particles) {
        p.y += p.speed * dt
        if (snow) {
          p.drift += dt
          p.x += Math.sin(p.drift) * 12 * dt
          ctx.moveTo(p.x + p.size, p.y)
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2)
        } else {
          p.x -= p.speed * 0.12 * dt
          ctx.moveTo(p.x, p.y)
          ctx.lineTo(p.x + p.size * 0.12, p.y - p.size)
        }
        if (p.y > height + 20) Object.assign(p, spawn(false))
      }
      if (snow) ctx.fill()
      else ctx.stroke()
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    window.addEventListener('resize', resize)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', resize)
      ctx.clearRect(0, 0, width, height)
    }
  }, [weather])

  return (
    <div className={`weather-overlay weather-${weather}`} aria-hidden="true">
      <canvas ref={canvas} />
    </div>
  )
}
