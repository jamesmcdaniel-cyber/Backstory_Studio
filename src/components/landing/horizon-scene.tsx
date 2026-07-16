'use client'

import { useEffect, useRef } from 'react'
import * as THREE from 'three'

/**
 * The landing hero's WebGL centerpiece: a slowly rotating, faceted icosahedron
 * in the Horizon palette with a faint wireframe shell — a physical "horizon"
 * object that catches light and leans toward the cursor.
 *
 * Deliberately VANILLA three.js (no @react-three/fiber): fiber bundles
 * react-reconciler, which couples to React's private internals and broke on
 * React 18.3 (ReactCurrentBatchConfig). Driving three directly from an effect
 * has zero React-version coupling, so it can't hit that class of bug. Loaded
 * only on the landing route (dynamic, ssr:false) and only when motion is
 * allowed; the CSS aurora stands in otherwise. All setup is guarded so a
 * WebGL-less client falls back cleanly to the aurora already painted behind it.
 */
export default function HorizonScene() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' })
    } catch {
      return // No WebGL — the aurora behind us is the fallback.
    }

    const sizeOf = () => ({
      w: canvas.clientWidth || 1,
      h: canvas.clientHeight || 1,
    })
    let { w, h } = sizeOf()
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
    renderer.setSize(w, h, false)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(42, w / h, 0.1, 100)
    camera.position.set(0, 0, 5)

    scene.add(new THREE.AmbientLight(0xffffff, 0.6))
    const key = new THREE.DirectionalLight(0xdbebf2, 2.2)
    key.position.set(4, 3, 5)
    scene.add(key)
    const fill = new THREE.DirectionalLight(0x18485c, 1.1)
    fill.position.set(-5, -2, -3)
    scene.add(fill)
    const rim = new THREE.PointLight(0x99c1d1, 12, 12)
    rim.position.set(0, 2, 3)
    scene.add(rim)

    const group = new THREE.Group()
    scene.add(group)

    const geometry = new THREE.IcosahedronGeometry(1.5, 4)
    const material = new THREE.MeshStandardMaterial({
      color: 0x447c93,
      emissive: 0x0a2f3f,
      emissiveIntensity: 0.35,
      roughness: 0.25,
      metalness: 0.55,
      flatShading: true,
    })
    const mesh = new THREE.Mesh(geometry, material)
    group.add(mesh)

    const wireGeometry = new THREE.IcosahedronGeometry(1.62, 2)
    const wireMaterial = new THREE.MeshBasicMaterial({ color: 0x7dacc0, wireframe: true, transparent: true, opacity: 0.12 })
    const wire = new THREE.Mesh(wireGeometry, wireMaterial)
    group.add(wire)

    // Pointer parallax: track the cursor across the window, normalized to -1…1.
    let pointerX = 0
    let pointerY = 0
    const onPointerMove = (event: PointerEvent) => {
      pointerX = (event.clientX / window.innerWidth) * 2 - 1
      pointerY = -((event.clientY / window.innerHeight) * 2 - 1)
    }
    window.addEventListener('pointermove', onPointerMove, { passive: true })

    const resize = () => {
      const next = sizeOf()
      w = next.w
      h = next.h
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h, false)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)

    const clock = new THREE.Clock()
    let raf = 0
    const render = () => {
      const delta = clock.getDelta()
      const t = clock.elapsedTime
      group.rotation.y += delta * 0.18
      group.rotation.x += (pointerY * 0.25 - group.rotation.x) * 0.04
      group.rotation.z += (pointerX * 0.15 - group.rotation.z) * 0.04
      group.position.y = Math.sin(t * 1.2) * 0.12
      renderer.render(scene, camera)
      raf = requestAnimationFrame(render)
    }
    render()

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', onPointerMove)
      observer.disconnect()
      geometry.dispose()
      material.dispose()
      wireGeometry.dispose()
      wireMaterial.dispose()
      renderer.dispose()
    }
  }, [])

  return <canvas ref={canvasRef} className="h-full w-full" />
}
