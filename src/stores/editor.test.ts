import { beforeEach, describe, expect, it } from 'vitest'
import { useEditorStore } from './editor'
import { resolveScene } from '../utils/prefabs'

function resetToEmpty() {
  useEditorStore.setState({
    name: '测试',
    objects: [],
    prefabs: [],
    selectedKey: null,
    selectedKeys: [],
    editingPrefabId: null,
    render: { phase: 'idle', done: 0, total: 0 },
    lastSnapshot: null,
    notice: '',
  })
}

beforeEach(() => {
  resetToEmpty()
})

describe('组合件制作与引用完整链路', () => {
  it('把选中的多个对象做成组合件并替换为引用实例', () => {
    const store = useEditorStore.getState()
    store.add('box')
    const boxId = useEditorStore.getState().selectedKey!
    store.add('sphere', boxId)
    store.select(boxId, true) // 多选：box + sphere（sphere 是 box 子级，实际根只有 box）

    expect(useEditorStore.getState().createPrefabFromSelection()).toBe(true)
    const state = useEditorStore.getState()
    expect(state.prefabs).toHaveLength(1)
    const handle = state.objects.find((object) => object.instanceOf)
    expect(handle).toBeTruthy()
    // 原子树被移除
    expect(state.objects.find((object) => object.id === boxId)).toBeUndefined()
  })

  it('源改材质颜色，未覆盖实例跟随；已覆盖实例保留', () => {
    const store = useEditorStore.getState()
    store.add('box')
    const boxId = useEditorStore.getState().selectedKey!
    store.createPrefabFromSelection()
    const state1 = useEditorStore.getState()
    const prefabId = state1.prefabs[0].id

    // 两个引用实例
    state1.addPrefabInstance(prefabId)
    useEditorStore.getState().addPrefabInstance(prefabId)
    const handles = useEditorStore.getState().objects.filter((object) => object.instanceOf)
    expect(handles).toHaveLength(3) // 制作时 1 + 再放 2

    // 第二个实例的根部件颜色覆盖为红色
    const prefab = useEditorStore.getState().prefabs[0]
    const rootNodeId = prefab.nodes.find((node) => !node.parentId)!.id
    useEditorStore.getState().updateNode(`instance:${handles[1].id}/${rootNodeId}`, {
      material: { color: '#ff0000' },
    })
    expect(useEditorStore.getState().objects.find((o) => o.id === handles[1].id)!.overrides).toHaveLength(1)

    // 进入源编辑，把颜色改成绿色
    useEditorStore.getState().enterPrefab(prefabId)
    useEditorStore.getState().updateNode(rootNodeId, {
      material: { ...prefab.nodes[0].material, color: '#00ff00' },
    })
    useEditorStore.getState().exitPrefab()

    const finalState = useEditorStore.getState()
    const resolved = resolveScene(finalState.objects, finalState.prefabs)
    const untouched = resolved.nodes.get(`instance:${handles[0].id}/${rootNodeId}`)!
    const overridden = resolved.nodes.get(`instance:${handles[1].id}/${rootNodeId}`)!
    expect(untouched.material.color).toBe('#00ff00')
    expect(overridden.material.color).toBe('#ff0000')
  })

  it('恢复覆盖后实例重新跟随源', () => {
    const store = useEditorStore.getState()
    store.add('box')
    store.createPrefabFromSelection()
    const state1 = useEditorStore.getState()
    const prefab = state1.prefabs[0]
    const rootNodeId = prefab.nodes[0].id
    const handle = state1.objects.find((o) => o.instanceOf)!

    const key = `instance:${handle.id}/${rootNodeId}`
    state1.updateNode(key, { material: { color: '#123456' } })
    expect(useEditorStore.getState().objects.find((o) => o.id === handle.id)!.overrides).toHaveLength(1)

    useEditorStore.getState().resetOverride(handle.id, rootNodeId, 'material.color')
    expect(useEditorStore.getState().objects.find((o) => o.id === handle.id)!.overrides ?? []).toHaveLength(0)
  })
})

describe('成环在操作入口被挡住', () => {
  it('在会成环的组合件源里放引用被拒绝', () => {
    const store = useEditorStore.getState()
    store.add('box')
    store.createPrefabFromSelection()
    const a = useEditorStore.getState().prefabs[0].id

    store.add('sphere')
    store.createPrefabFromSelection()
    const b = useEditorStore.getState().prefabs[1].id

    // 进入 a，放 b；再进入 b，尝试放 a —— a->b->a 成环，应被挡
    useEditorStore.getState().enterPrefab(a)
    useEditorStore.getState().addPrefabInstance(b)
    expect(useEditorStore.getState().prefabs.find((p) => p.id === a)!.nodes.some((n) => n.instanceOf === b)).toBe(true)
    useEditorStore.getState().exitPrefab()

    useEditorStore.getState().enterPrefab(b)
    const before = useEditorStore.getState().prefabs.find((p) => p.id === b)!.nodes.length
    useEditorStore.getState().addPrefabInstance(a)
    const after = useEditorStore.getState().prefabs.find((p) => p.id === b)!.nodes.length
    expect(after).toBe(before) // 没放进去
    expect(useEditorStore.getState().notice).toContain('环')
  })
})

describe('旧数据迁移读入', () => {
  it('v1 文档经 loadScene 升级后可正常解析', () => {
    const legacy = {
      version: 1,
      name: '老展台',
      objects: [{ id: 'legacy-box', type: 'box', position: [1, 1, 1] }],
    }
    useEditorStore.getState().loadScene(legacy)
    const state = useEditorStore.getState()
    expect(state.prefabs).toEqual([])
    expect(state.objects[0].rotation).toEqual([0, 0, 0])
    expect(state.notice).toContain('升级')
    const resolved = resolveScene(state.objects, state.prefabs)
    expect(resolved.nodes.get('legacy-box')).toBeTruthy()
  })
})

describe('渲染快照与恢复', () => {
  it('takeSnapshot 保存现场，restoreSnapshot 回滚对象与选择', () => {
    const store = useEditorStore.getState()
    store.add('box')
    const firstId = useEditorStore.getState().selectedKey
    const snapshot = useEditorStore.getState().takeSnapshot([1, 2, 3], [0, 0, 0])

    store.add('sphere')
    store.select(useEditorStore.getState().objects.at(-1)!.id)
    expect(useEditorStore.getState().objects.length).toBe(2)

    useEditorStore.getState().restoreSnapshot(snapshot)
    const restored = useEditorStore.getState()
    expect(restored.objects.length).toBe(1)
    expect(restored.selectedKey).toBe(firstId)
    expect(restored.render.phase).toBe('recovering')
    expect(restored.notice).toContain('恢复')
  })
})
