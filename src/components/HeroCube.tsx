import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/** 首屏三阶魔方：圆角块体 + 物理材质贴片，悬浮、缓慢自转、周期性转动一层，支持拖拽查看 */

const PALETTE = [
  { color: '#2f6bff', weight: 0.4 }, // 电光蓝
  { color: '#f3f7ff', weight: 0.33 }, // 冰川白
  { color: '#ff8757', weight: 0.21 }, // 珊瑚橙
  { color: '#1c2436', weight: 0.06 }, // 深色块
];

/** 固定种子的伪随机，保证每次打开颜色分布一致 */
function seeded(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export default function HeroCube({ className }: { className?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    } catch {
      host.classList.add('no-webgl');
      return;
    }
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Neutral 色调映射比 ACES 更能保留贴片的饱和度
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.0;
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTex;

    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    camera.position.set(0, 0.3, 16);

    scene.add(new THREE.HemisphereLight('#ffffff', '#b8c8ee', 0.9));
    const key = new THREE.DirectionalLight('#ffffff', 2.6);
    key.position.set(4, 6, 6);
    scene.add(key);
    const rim = new THREE.DirectionalLight('#7fb6ff', 1.6);
    rim.position.set(-6, -2, -4);
    scene.add(rim);

    // —— 魔方 ——
    const root = new THREE.Group(); // 姿态（倾斜 + 拖拽）
    const cube = new THREE.Group(); // 块体容器，层转动时从这里取出
    root.add(cube);
    scene.add(root);

    const bodyGeo = new RoundedBoxGeometry(0.98, 0.98, 0.98, 4, 0.13);
    const bodyMat = new THREE.MeshPhysicalMaterial({ color: '#0d1422', roughness: 0.35, metalness: 0.1, clearcoat: 0.6, clearcoatRoughness: 0.3 });
    const tileGeo = new RoundedBoxGeometry(0.82, 0.82, 0.06, 3, 0.1);
    const tileMats = PALETTE.map(
      (p) => new THREE.MeshPhysicalMaterial({ color: p.color, roughness: 0.3, metalness: 0, clearcoat: 0.7, clearcoatRoughness: 0.2, envMapIntensity: 0.7 }),
    );
    const rand = seeded(20260911);
    const pick = () => {
      let r = rand();
      for (let i = 0; i < PALETTE.length; i++) {
        r -= PALETTE[i].weight;
        if (r <= 0) return tileMats[i];
      }
      return tileMats[0];
    };
    const normals: [THREE.Vector3, THREE.Euler][] = [
      [new THREE.Vector3(1, 0, 0), new THREE.Euler(0, Math.PI / 2, 0)],
      [new THREE.Vector3(-1, 0, 0), new THREE.Euler(0, -Math.PI / 2, 0)],
      [new THREE.Vector3(0, 1, 0), new THREE.Euler(-Math.PI / 2, 0, 0)],
      [new THREE.Vector3(0, -1, 0), new THREE.Euler(Math.PI / 2, 0, 0)],
      [new THREE.Vector3(0, 0, 1), new THREE.Euler(0, 0, 0)],
      [new THREE.Vector3(0, 0, -1), new THREE.Euler(0, Math.PI, 0)],
    ];
    const cubies: THREE.Group[] = [];
    for (let x = -1; x <= 1; x++) {
      for (let y = -1; y <= 1; y++) {
        for (let z = -1; z <= 1; z++) {
          const g = new THREE.Group();
          g.position.set(x, y, z);
          g.add(new THREE.Mesh(bodyGeo, bodyMat));
          for (const [n, rot] of normals) {
            if (n.x !== 0 && n.x !== x) continue;
            if (n.y !== 0 && n.y !== y) continue;
            if (n.z !== 0 && n.z !== z) continue;
            const tile = new THREE.Mesh(tileGeo, pick());
            tile.position.copy(n).multiplyScalar(0.5);
            tile.rotation.copy(rot);
            g.add(tile);
          }
          cube.add(g);
          cubies.push(g);
        }
      }
    }

    // —— 光晕、能量环与粒子 ——
    const glowCanvas = document.createElement('canvas');
    glowCanvas.width = glowCanvas.height = 256;
    const gctx = glowCanvas.getContext('2d')!;
    const grad = gctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0, 'rgba(150,200,255,0.55)');
    grad.addColorStop(0.45, 'rgba(120,170,255,0.18)');
    grad.addColorStop(1, 'rgba(120,170,255,0)');
    gctx.fillStyle = grad;
    gctx.fillRect(0, 0, 256, 256);
    const glowTex = new THREE.CanvasTexture(glowCanvas);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    glow.scale.set(11, 11, 1);
    glow.position.z = -2;
    scene.add(glow);

    const rings: THREE.Mesh[] = [];
    const ringSpecs = [
      { r: 3.1, tilt: [1.15, 0.2, 0.3], color: '#9fd6ff', opacity: 0.55 },
      { r: 3.6, tilt: [1.35, -0.5, -0.2], color: '#b9b2ff', opacity: 0.35 },
      { r: 2.75, tilt: [0.5, 0.9, 0.1], color: '#8ec5ff', opacity: 0.3 },
    ];
    for (const s of ringSpecs) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(s.r, 0.012, 8, 220),
        new THREE.MeshBasicMaterial({ color: s.color, transparent: true, opacity: s.opacity, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      ring.rotation.set(s.tilt[0], s.tilt[1], s.tilt[2]);
      scene.add(ring);
      rings.push(ring);
    }

    const pCount = 260;
    const pPos = new Float32Array(pCount * 3);
    const pr = seeded(7);
    for (let i = 0; i < pCount; i++) {
      const radius = 2.6 + pr() * 2.4;
      const theta = pr() * Math.PI * 2;
      const phi = (pr() - 0.5) * 1.6;
      pPos[i * 3] = Math.cos(theta) * radius;
      pPos[i * 3 + 1] = Math.sin(phi) * radius * 0.6;
      pPos[i * 3 + 2] = Math.sin(theta) * radius * 0.5;
    }
    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
    const particles = new THREE.Points(
      pGeo,
      new THREE.PointsMaterial({ color: '#cfe6ff', size: 0.045, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    scene.add(particles);

    // —— 姿态与交互 ——
    const base = new THREE.Euler(0.58, -0.78, 0.18);
    const drag = { active: false, x: 0, y: 0, rx: 0, ry: 0, vx: 0, vy: 0 };
    const onDown = (e: PointerEvent) => {
      drag.active = true;
      drag.x = e.clientX;
      drag.y = e.clientY;
      renderer.domElement.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!drag.active) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      drag.vy = dx * 0.008;
      drag.vx = dy * 0.008;
      drag.ry += drag.vy;
      drag.rx = Math.max(-1, Math.min(1, drag.rx + drag.vx));
    };
    const onUp = () => {
      drag.active = false;
    };
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointermove', onMove);
    renderer.domElement.addEventListener('pointerup', onUp);
    renderer.domElement.addEventListener('pointercancel', onUp);

    // —— 层转动 ——
    type Turn = { pivot: THREE.Group; axis: 'x' | 'y' | 'z'; angle: number; start: number };
    let turn: Turn | null = null;
    let nextTurnAt = 1.6;
    const startTurn = (now: number) => {
      const axes = ['x', 'y', 'z'] as const;
      const axis = axes[Math.floor(Math.random() * 3)];
      const layer = [-1, 0, 1][Math.floor(Math.random() * 3)];
      const pivot = new THREE.Group();
      cube.add(pivot);
      for (const c of cubies) if (Math.abs(c.position[axis] - layer) < 0.1) pivot.attach(c);
      turn = { pivot, axis, angle: (Math.random() < 0.5 ? 1 : -1) * (Math.PI / 2), start: now };
    };
    const finishTurn = () => {
      if (!turn) return;
      turn.pivot.rotation[turn.axis] = turn.angle;
      turn.pivot.updateMatrixWorld();
      for (const c of [...turn.pivot.children] as THREE.Group[]) {
        cube.attach(c);
        c.position.set(Math.round(c.position.x), Math.round(c.position.y), Math.round(c.position.z));
        // 旋转对齐到 90° 的整数倍，避免浮点误差累积
        const e = new THREE.Euler().setFromQuaternion(c.quaternion);
        const snap = (v: number) => Math.round(v / (Math.PI / 2)) * (Math.PI / 2);
        c.rotation.set(snap(e.x), snap(e.y), snap(e.z));
      }
      cube.remove(turn.pivot);
      turn = null;
    };

    // —— 渲染循环 ——
    let raf = 0;
    let visible = true;
    const clock = new THREE.Clock();
    const resize = () => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      // 窄屏时拉远镜头，保证魔方与能量环完整
      camera.position.z = w / h < 0.9 ? 18.5 : w < 560 ? 12.5 : 16;
      camera.updateProjectionMatrix();
      // 光晕不能超出画布，否则边缘会出现矩形硬边
      const dist = camera.position.z - glow.position.z;
      const visH = 2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const s = Math.min(visH, visH * camera.aspect) * 0.98;
      glow.scale.set(s, s, 1);
    };
    const frame = () => {
      const t = clock.getElapsedTime();
      if (!reduceMotion) {
        root.position.y = Math.sin(t * 0.9) * 0.12;
        if (!drag.active) {
          // 自转为缓慢往复摆动，始终展示顶面、正面与侧面
          drag.ry += drag.vy + (Math.sin(t * 0.25) * 0.45 - drag.ry) * 0.02;
          drag.vy *= 0.92;
          drag.vx *= 0.92;
          drag.rx *= 0.95; // 松手后回到默认倾角
        }
        rings.forEach((r, i) => (r.rotation.z += 0.0012 * (i % 2 ? -1 : 1)));
        particles.rotation.y = t * 0.03;
        if (!turn && t >= nextTurnAt) startTurn(t);
        if (turn) {
          const p = Math.min(1, (t - turn.start) / 0.75);
          turn.pivot.rotation[turn.axis] = turn.angle * easeInOut(p);
          if (p >= 1) {
            finishTurn();
            nextTurnAt = t + 2.2 + Math.random() * 1.6;
          }
        }
      }
      root.rotation.set(base.x + drag.rx, base.y + drag.ry, base.z);
      renderer.render(scene, camera);
      if (visible) raf = requestAnimationFrame(frame);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();
    // 离开视口或标签页隐藏时暂停渲染
    const io = new IntersectionObserver(([entry]) => {
      const was = visible;
      visible = entry.isIntersecting && document.visibilityState === 'visible';
      if (visible && !was) raf = requestAnimationFrame(frame);
    });
    io.observe(host);
    const onVis = () => {
      const was = visible;
      visible = document.visibilityState === 'visible';
      if (visible && !was) raf = requestAnimationFrame(frame);
    };
    document.addEventListener('visibilitychange', onVis);
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      visible = false;
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointermove', onMove);
      renderer.domElement.removeEventListener('pointerup', onUp);
      renderer.domElement.removeEventListener('pointercancel', onUp);
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
      glowTex.dispose();
      envTex.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return <div ref={hostRef} className={`hero-cube ${className ?? ''}`} aria-label="三阶魔方 3D 展示，可拖拽旋转" role="img" />;
}
