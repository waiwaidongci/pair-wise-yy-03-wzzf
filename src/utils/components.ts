import * as THREE from 'three'
import type {
  ComponentDef,
  ComponentTemplateNode,
  SceneDocument,
  SceneObject,
  Vec3,
} from '../types/scene'
import { createSceneObject, uid, worldMatrix } from './scene'

/** 当前文档版本：2 = 含组合件库 */
export const CURRENT_VERSION = 2

/** 引用实例数量超过该阈值时启用分批渲染 */
export const BATCH_INSTANCE_THRESHOLD = 40
/** 每批渲染的实例数量 */
export const BATCH_CHUNK_SIZE = 12

export function cloneSceneObject(obj: SceneObject): SceneObject {
  return JSON.parse(JSON.stringify(obj)) as SceneObject
}

export function cloneTemplateNode(node: ComponentTemplateNode): ComponentTemplateNode {
  return { object: cloneSceneObject(node.object), children: node.children.map(cloneTemplateNode) }
}

function hasSelectedAncestor(id: string, objects: SceneObject[], selected: Set<string>): boolean {
  let current = objects.find((item) => item.id === id)
  while (current?.parentId) {
    if (selected.has(current.parentId)) return true
    current = objects.find((item) => item.id === current!.parentId)
  }
  return false
}

function createBareRoot(): SceneObject {
  const root = createSceneObject('box')
  root.id = uid('tpl')
  root.name = '组合件根节点'
  root.position = [0, 0, 0]
  root.rotation = [0, 0, 0]
  root.scale = [1, 1, 1]
  return root
}

function worldTransformOf(id: string, objects: SceneObject[]) {
  const matrix = worldMatrix(id, objects)
  const position = new THREE.Vector3()
  const quaternion = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  matrix.decompose(position, quaternion, scale)
  const euler = new THREE.Euler().setFromQuaternion(quaternion)
  return {
    position: [position.x, position.y, position.z] as Vec3,
    rotation: [euler.x, euler.y, euler.z] as Vec3,
    scale: [scale.x, scale.y, scale.z] as Vec3,
  }
}

/**
 * 把选中的一组对象做成组合件模板。
 * 选中多个对象时，最顶层的选中对象作为模板根；
 * 若选中了多个互不为父子的对象，则用一个虚拟根节点承载，
 * 并把各对象的世界变换转到根节点下，保证外观不变。
 */
export function buildComponentFromSelection(ids: string[], objects: SceneObject[]): ComponentDef | null {
  const selected = new Set(ids)
  const roots = objects.filter((item) => selected.has(item.id) && !hasSelectedAncestor(item.id, objects, selected))
  if (roots.length === 0) return null

  const nodeFrom = (id: string): ComponentTemplateNode => {
    const source = objects.find((item) => item.id === id)
    if (!source) return { object: createBareRoot(), children: [] }
    return {
      object: cloneSceneObject(source),
      children: objects.filter((item) => item.parentId === id).map((item) => nodeFrom(item.id)),
    }
  }

  let root: ComponentTemplateNode
  if (roots.length === 1) {
    root = nodeFrom(roots[0].id)
  } else {
    root = {
      object: createBareRoot(),
      children: roots.map((item) => {
        const node = nodeFrom(item.id)
        const transform = worldTransformOf(item.id, objects)
        node.object.position = transform.position
        node.object.rotation = transform.rotation
        node.object.scale = transform.scale
        return node
      }),
    }
  }

  return { id: uid('comp'), name: `${roots[0].name} 组合件`, root }
}

/** 在场景中放置一个引用实例，实例的初始变换与材质取自源组合件 */
export function instantiateComponent(component: ComponentDef, parentId: string | null): SceneObject {
  const template = component.root.object
  const instance = createSceneObject(template.type, parentId)
  instance.id = uid('inst')
  instance.name = component.name
  instance.position = [...template.position]
  instance.rotation = [...template.rotation]
  instance.scale = [...template.scale]
  instance.material = JSON.parse(JSON.stringify(template.material)) as SceneObject['material']
  instance.componentId = component.id
  instance.overrides = { position: false, material: false }
  instance.castShadow = template.castShadow
  instance.receiveShadow = template.receiveShadow
  return instance
}

/** 把模板拍平成对象数组（用于组合件编辑模式） */
export function flattenTemplate(root: ComponentTemplateNode): SceneObject[] {
  const result: SceneObject[] = []
  const walk = (node: ComponentTemplateNode, parentId: string | null) => {
    result.push({ ...node.object, parentId })
    node.children.forEach((child) => walk(child, node.object.id))
  }
  walk(root, null)
  return result
}

/** 从对象数组重建模板（编辑完成后提交） */
export function buildTemplateFromObjects(objects: SceneObject[]): ComponentTemplateNode {
  const roots = objects.filter((item) => !item.parentId)
  const nodeFrom = (obj: SceneObject): ComponentTemplateNode => ({
    object: cloneSceneObject(obj),
    children: objects.filter((item) => item.parentId === obj.id).map((item) => nodeFrom(item)),
  })
  if (roots.length === 1) return nodeFrom(roots[0])
  return {
    object: createBareRoot(),
    children: roots.map((item) => {
      const node = nodeFrom(item)
      const transform = worldTransformOf(item.id, objects)
      node.object.position = transform.position
      node.object.rotation = transform.rotation
      node.object.scale = transform.scale
      return node
    }),
  }
}

export interface ResolvedNode {
  object: SceneObject
  children: ResolvedNode[]
}

function placeholderFor(obj: SceneObject): SceneObject {
  return {
    ...obj,
    material: { ...obj.material, color: '#ff2bd6', wireframe: true, opacity: 1 },
  }
}

/** 递归解析模板，遇到嵌套引用实例则展开其源模板 */
function resolveTemplateNode(
  node: ComponentTemplateNode,
  components: ComponentDef[],
  seen: Set<string>,
): ResolvedNode {
  const obj = cloneSceneObject(node.object)
  if (obj.componentId) {
    if (seen.has(obj.componentId)) return { object: placeholderFor(obj), children: [] }
    const component = components.find((item) => item.id === obj.componentId)
    if (!component) return { object: placeholderFor(obj), children: [] }
    const nextSeen = new Set(seen)
    nextSeen.add(obj.componentId)
    const inner = resolveTemplateNode(component.root, components, nextSeen)
    return { object: obj, children: [inner] }
  }
  return {
    object: obj,
    children: node.children.map((child) => resolveTemplateNode(child, components, seen)),
  }
}

/**
 * 解析引用实例：展开源组合件模板，并应用实例自身的覆盖。
 * 未覆盖的属性跟随源模板，源改动会反映到解析结果中；
 * 已覆盖的位置/材质使用实例自身的值，源改动盖不掉。
 */
export function resolveInstance(instance: SceneObject, components: ComponentDef[]): ResolvedNode {
  const component = components.find((item) => item.id === instance.componentId)
  if (!component) return { object: placeholderFor(instance), children: [] }
  const root = resolveTemplateNode(component.root, components, new Set([component.id]))
  if (instance.overrides?.position) {
    root.object.position = [...instance.position]
    root.object.rotation = [...instance.rotation]
    root.object.scale = [...instance.scale]
  }
  if (instance.overrides?.material) {
    root.object.material = JSON.parse(JSON.stringify(instance.material)) as SceneObject['material']
  }
  return root
}

function walkTemplate(node: ComponentTemplateNode, visit: (node: ComponentTemplateNode) => void) {
  visit(node)
  node.children.forEach((child) => walkTemplate(child, visit))
}

/** 组合件模板中直接或间接引用到的其它组合件 id 集合 */
export function componentTransitiveRefs(componentId: string, components: ComponentDef[]): Set<string> {
  const result = new Set<string>()
  const visit = (id: string) => {
    if (result.has(id)) return
    result.add(id)
    const component = components.find((item) => item.id === id)
    if (!component) return
    walkTemplate(component.root, (node) => {
      if (node.object.componentId) visit(node.object.componentId)
    })
  }
  visit(componentId)
  result.delete(componentId)
  return result
}

/**
 * 判断把 referencedId 的引用实例放进 containerId 的模板是否会形成环。
 * 环的判定：referencedId 的模板传递引用了 containerId（或引用自身）。
 */
export function wouldCreateCycle(containerId: string, referencedId: string, components: ComponentDef[]): boolean {
  if (containerId === referencedId) return true
  return componentTransitiveRefs(referencedId, components).has(containerId)
}

/** 统计引用了某组合件的实例数量 */
export function countInstances(componentId: string, objects: SceneObject[]): number {
  return objects.filter((item) => item.componentId === componentId).length
}

/**
 * 升级旧文档：旧数据没有组合件信息（version < 2），
 * 读入前先补齐 components 字段，避免后续逻辑读到 undefined。
 */
export function migrateDocument(raw: unknown): SceneDocument {
  const doc = (raw ?? {}) as Partial<SceneDocument> & { version?: number; components?: ComponentDef[] }
  const version = typeof doc.version === 'number' ? doc.version : 1
  const objects = Array.isArray(doc.objects) ? (doc.objects as SceneObject[]) : []
  const components = Array.isArray(doc.components) ? doc.components : []
  if (version < CURRENT_VERSION) {
    return {
      version: CURRENT_VERSION,
      name: doc.name ?? '未命名场景',
      objects,
      components,
      savedAt: doc.savedAt ?? new Date().toISOString(),
    }
  }
  return {
    version: CURRENT_VERSION,
    name: doc.name ?? '未命名场景',
    objects,
    components,
    savedAt: doc.savedAt ?? new Date().toISOString(),
  }
}

/**
 * 最近一次成功渲染的现场快照。
 * 渲染失败时由错误边界恢复，避免白屏后场景丢失。
 */
export let lastGoodSnapshot: { objects: SceneObject[]; components: ComponentDef[] } | null = null

export function captureSnapshot(objects: SceneObject[], components: ComponentDef[]) {
  lastGoodSnapshot = {
    objects: objects.map(cloneSceneObject),
    components: components.map((component) => ({ id: component.id, name: component.name, root: cloneTemplateNode(component.root) })),
  }
}
