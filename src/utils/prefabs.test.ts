import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { MaterialSpec, PrefabAsset, SceneDocument, SceneObject } from '../types/scene'
import { createInstanceHandle, createSceneObject } from './scene'
import {
  applyOverride,
  instanceKey,
  resolvePrefab,
  resolveScene,
  resolvedWorldMatrix,
  wouldCreateCycle,
  type ResolveResult,
} from './prefabs'
import { migrateDocument } from './migration'
import { planRenderChunks } from './renderBatches'

function material(color = '#888888'): MaterialSpec {
  return { color, roughness: 0.5, metalness: 0, opacity: 1, wireframe: false }
}

function makePrefab(id: string, nodes: SceneObject[], name = id): PrefabAsset {
  return { id, name, nodes, createdAt: new Date().toISOString() }
}

/** 单根组合件：底座(base) + 子物体(top) */
function boothPrefab(id = 'booth', topColor = '#2563eb'): PrefabAsset {
  const base = createSceneObject('cylinder')
  base.id = `${id}-base`
  base.position = [0, 0.5, 0]
  base.material = material('#e2e8f0')

  const top = createSceneObject('box')
  top.id = `${id}-top`
  top.parentId = `${id}-base`
  top.position = [0, 0.9, 0]
  top.material = material(topColor)

  return makePrefab(id, [base, top], '展柜')
}

describe('1. 组合件解析与引用实例', () => {
  it('引用实例展开成模板部件，多实例各自独立', () => {
    const prefab = boothPrefab()
    const a = createInstanceHandle(prefab, '展柜 A', [-2, 0, 0])
    a.id = 'a'
    const b = createInstanceHandle(prefab, '展柜 B', [2, 0, 0])
    b.id = 'b'

    const result = resolveScene([a, b], [prefab])
    expect(result.issues).toHaveLength(0)
    // 每个实例展开出 base/top 两个部件
    expect(result.nodes.has(instanceKey('a', 'booth-base'))).toBe(true)
    expect(result.nodes.has(instanceKey('a', 'booth-base/booth-top'))).toBe(true)
    expect(result.nodes.has(instanceKey('b', 'booth-base'))).toBe(true)
    expect(result.nodes.has(instanceKey('b', 'booth-base/booth-top'))).toBe(true)
    expect(result.roots).toHaveLength(2)
  })

  it('实例根继承句柄摆放位置，模板其余相对关系保持', () => {
    const prefab = boothPrefab()
    const handle = createInstanceHandle(prefab, '展柜', [3, 0, 4])
    handle.id = 'h'
    const result = resolveScene([handle], [prefab])
    const root = result.nodes.get(instanceKey('h', 'booth-base'))!
    expect(root.position).toEqual([3, 0, 4])
    const top = result.nodes.get(instanceKey('h', 'booth-base/booth-top'))!
    expect(top.position).toEqual([0, 0.9, 0])
    expect(top.parentKey).toBe(instanceKey('h', 'booth-base'))
  })
})

describe('2. 源改动传播 / 私有覆盖保留', () => {
  it('源改一个细节，没调过的实例跟着重算', () => {
    const prefab = boothPrefab()
    const a = createInstanceHandle(prefab, 'A', [0, 0, 0])
    a.id = 'a'
    const b = createInstanceHandle(prefab, 'B', [2, 0, 0])
    b.id = 'b'
    let result = resolveScene([a, b], [prefab])
    expect(result.nodes.get(instanceKey('a', 'booth-base'))!.material.roughness).toBeCloseTo(0.5)

    // 源：底座粗糙度改成 0.1
    prefab.nodes[0].material.roughness = 0.1
    result = resolveScene([a, b], [prefab])
    expect(result.nodes.get(instanceKey('a', 'booth-base'))!.material.roughness).toBeCloseTo(0.1)
    expect(result.nodes.get(instanceKey('b', 'booth-base'))!.material.roughness).toBeCloseTo(0.1)
  })

  it('单独调过的材质颜色被保留，源改同字段盖不掉；未覆盖的粗糙度仍跟随', () => {
    const prefab = boothPrefab('booth', '#2563eb')
    const handle = createInstanceHandle(prefab, 'B', [0, 0, 0])
    handle.id = 'b'
    // B 只覆盖了 top 的颜色
    handle.overrides = [{ nodePath: 'booth-top', patch: { material: { color: '#dc2626' } } }]

    let result = resolveScene([handle], [prefab])
    let top = result.nodes.get(instanceKey('b', 'booth-base/booth-top'))!
    expect(top.material.color).toBe('#dc2626')
    expect(top.material.roughness).toBeCloseTo(0.5)

    // 源改颜色和粗糙度
    const sourceTop = prefab.nodes.find((n) => n.id === 'booth-top')!
    sourceTop.material.color = '#16a34a'
    sourceTop.material.roughness = 0.2
    result = resolveScene([handle], [prefab])
    top = result.nodes.get(instanceKey('b', 'booth-base/booth-top'))!
    expect(top.material.color).toBe('#dc2626') // 覆盖保留，源盖不掉
    expect(top.material.roughness).toBeCloseTo(0.2) // 没覆盖，跟随源
  })

  it('位置/旋转/缩放覆盖同样保留', () => {
    const prefab = boothPrefab()
    const handle = createInstanceHandle(prefab, 'B', [0, 0, 0])
    handle.id = 'b'
    // top 是根 base 的子节点，顶层实例里部件的覆盖键就是模板相对路径（不含根前缀）
    handle.overrides = [{ nodePath: 'booth-top', patch: { position: [1, 2, 3] } }]
    const sourceTop = prefab.nodes.find((n) => n.id === 'booth-top')!
    sourceTop.position = [9, 9, 9]
    const result = resolveScene([handle], [prefab])
    expect(result.nodes.get(instanceKey('b', 'booth-base/booth-top'))!.position).toEqual([1, 2, 3])
  })

  it('applyOverride 做字段级合并，向量整体替换', () => {
    const base = createSceneObject('box')
    base.position = [1, 1, 1]
    const merged = applyOverride(base, { position: [2, 0, 0] })
    expect(merged.position).toEqual([2, 0, 0])
    expect(merged.visible).toBe(true)
  })
})

describe('3. 嵌套成环防护', () => {
  it('wouldCreateCycle 能识别直接与间接环，顶层放引用不算环', () => {
    const a = boothPrefab('a')
    const b = boothPrefab('b')
    const c = boothPrefab('c')
    // a 内含 b，b 内含 c
    const refInA = createInstanceHandle(b, 'b-in-a', [0, 0, 0])
    a.nodes.push(refInA)
    const refInB = createInstanceHandle(c, 'c-in-b', [0, 0, 0])
    b.nodes.push(refInB)
    const prefabs = [a, b, c]

    // 在 c 里放 a：a->b->c->a，成环
    expect(wouldCreateCycle(prefabs, 'c', 'a')).toBe(true)
    // 在 b 里再放 b：自环
    expect(wouldCreateCycle(prefabs, 'b', 'b')).toBe(true)
    // 在 a 里放 c：a->b->c 再到 c，不会回到 a
    expect(wouldCreateCycle(prefabs, 'a', 'c')).toBe(false)
    // 顶层场景放任何引用都不算环
    expect(wouldCreateCycle(prefabs, null, 'a')).toBe(false)
  })

  it('解析器遇到环会截断并报 issue，不死循环', () => {
    const a = boothPrefab('a')
    const b = boothPrefab('b')
    // a 模板里放 b 的实例，b 模板里放 a 的实例
    a.nodes.push(createInstanceHandle(b, 'bref', [0, 0, 0]))
    b.nodes.push(createInstanceHandle(a, 'aref', [0, 0, 0]))
    const topHandle = createInstanceHandle(a, 'top', [0, 0, 0])

    const result = resolveScene([topHandle], [a, b])
    const cycleIssues = result.issues.filter((issue) => issue.kind === 'cycle')
    expect(cycleIssues.length).toBeGreaterThan(0)
    // 节点数有限（若死循环测试会超时）
    expect(result.nodes.size).toBeLessThan(50)
  })

  it('缺失引用报 missingPrefab，不抛异常', () => {
    const handle = createInstanceHandle(boothPrefab(), 'x', [0, 0, 0])
    handle.id = 'x'
    handle.instanceOf = 'gone'
    const result = resolveScene([handle], [])
    expect(result.issues.some((issue) => issue.kind === 'missingPrefab')).toBe(true)
  })

  it('嵌套实例的句柄自带覆盖沿路径传递到内层部件', () => {
    // inner 是 base+top；outer 模板内有一个引用 inner 的句柄，句柄把 inner 的 top 改白
    const inner = boothPrefab('inner')
    const nestedHandle = createInstanceHandle(inner, 'inner-ref', [0, 0, 0])
    nestedHandle.id = 'inner-ref'
    nestedHandle.overrides = [{ nodePath: 'inner-top', patch: { material: { color: '#ffffff' } } }]
    const outer = makePrefab('outer', [nestedHandle], '外层')

    const handle = createInstanceHandle(outer, 'h', [0, 0, 0])
    handle.id = 'h'
    const result = resolveScene([handle], [outer, inner])
    const innerTop = [...result.nodes.values()].find(
      (node) => node.nodePath?.endsWith('inner-top') && node.instanceId?.startsWith('h'),
    )!
    expect(innerTop).toBeTruthy()
    expect(innerTop.material.color).toBe('#ffffff')
    expect(result.issues).toHaveLength(0)
  })
})

describe('4. 旧数据迁移', () => {
  it('v1（无 prefabs/无版本）先升级为 v2 再读入，并补齐字段', () => {
    const legacy = {
      version: 1,
      name: '老场景',
      objects: [
        { id: 'o1', name: '方块', type: 'box', position: [1, 2, 3] },
        { id: 'o2', type: 'sphere', material: { color: '#abc' } },
      ],
      savedAt: '2024-01-01',
    }
    const { document, fromVersion } = migrateDocument(legacy)
    expect(fromVersion).toBe(1)
    expect(document.version).toBe(2)
    expect(document.prefabs).toEqual([])
    expect(document.objects).toHaveLength(2)
    const o1 = document.objects[0]
    expect(o1.rotation).toEqual([0, 0, 0])
    expect(o1.scale).toEqual([1, 1, 1])
    expect(o1.material.roughness).toBeCloseTo(0.45)
    expect(o1.visible).toBe(true)
    expect(document.objects[1].name).toBeTruthy()
  })

  it('完全无版本的脏数据也能安全规范化', () => {
    const { document } = migrateDocument({ objects: [{ type: 'nonsense' }, null, 42] })
    expect(document.version).toBe(2)
    expect(document.objects).toHaveLength(1)
    expect(document.objects[0].type).toBe('box')
  })

  it('v2 数据原样保留组合件定义', () => {
    const prefab = boothPrefab()
    const handle = createInstanceHandle(prefab, 'h', [0, 0, 0])
    const doc: SceneDocument = {
      version: 2,
      name: '新',
      objects: [handle],
      prefabs: [prefab],
      savedAt: new Date().toISOString(),
    }
    const { document } = migrateDocument(doc)
    expect(document.prefabs).toHaveLength(1)
    expect(document.objects[0].instanceOf).toBe(prefab.id)
  })
})

describe('5. 分批渲染计划', () => {
  function flatNodes(count: number): import('../utils/prefabs').ResolvedNode[] {
    return Array.from({ length: count }, (_, index) => {
      const object = createSceneObject('box')
      return {
        ...object,
        id: `n${index}`,
        key: `n${index}`,
        parentKey: null,
        instanceId: null,
        nodePath: null,
        overridden: false,
      }
    })
  }

  it('数量低于阈值时单批一次渲染', () => {
    const chunks = planRenderChunks(flatNodes(100), { chunkSize: 80, threshold: 150 })
    expect(chunks).toHaveLength(1)
  })

  it('数量超阈值时按深度有序分批，任意前缀覆盖完整父链', () => {
    // 构造 3 层树：根 -> 120 个子 -> 每个子 1 个孙（共 241）
    const nodes: import('../utils/prefabs').ResolvedNode[] = []
    const root = flatNodes(1)[0]
    root.key = 'root'
    nodes.push(root)
    for (let i = 0; i < 120; i += 1) {
      const child = flatNodes(1)[0]
      child.key = `c${i}`
      child.parentKey = 'root'
      const grand = flatNodes(1)[0]
      grand.key = `g${i}`
      grand.parentKey = `c${i}`
      nodes.push(child, grand)
    }
    const chunks = planRenderChunks(nodes, { chunkSize: 80, threshold: 150 })
    expect(chunks.length).toBeGreaterThan(1)
    // 任意前缀：出现的节点其父节点必已出现
    const revealed = new Set<string>()
    for (const chunk of chunks) {
      chunk.forEach((node) => {
        if (node.parentKey) expect(revealed.has(node.parentKey)).toBe(true)
        revealed.add(node.key)
      })
    }
    expect(revealed.size).toBe(241)
  })
})

describe('组合件源编辑解析', () => {
  it('resolvePrefab 直接展开模板并同样处理嵌套引用', () => {
    const inner = boothPrefab('inner')
    const group = createSceneObject('group')
    group.id = 'wrap'
    group.instanceOf = 'inner'
    const outer = makePrefab('outer', [group])
    const result: ResolveResult = resolvePrefab(outer, [outer, inner])
    expect(result.nodes.size).toBeGreaterThanOrEqual(2)
    expect(result.issues).toHaveLength(0)
  })
})

describe('世界矩阵烘焙一致性', () => {
  it('实例部件的解析世界矩阵等于句柄变换叠加模板局部链', () => {
    const prefab = boothPrefab()
    // 句柄 y=0.5：根 base 被整体摆放到 y=0.5，top 相对 0.9 → 世界 1.4
    const handle = createInstanceHandle(prefab, 'h', [2, 0.5, 0])
    handle.id = 'h'
    const result = resolveScene([handle], [prefab])
    const cache = new Map<string, THREE.Matrix4>()
    const topWorld = resolvedWorldMatrix(instanceKey('h', 'booth-base/booth-top'), result.nodes, cache)
    const position = new THREE.Vector3()
    topWorld.decompose(position, new THREE.Quaternion(), new THREE.Vector3())
    expect(position.x).toBeCloseTo(2)
    expect(position.y).toBeCloseTo(1.4)
  })
})
