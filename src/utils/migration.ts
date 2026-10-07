import type { MaterialSpec, ObjectType, PrefabAsset, SceneDocument, SceneObject, Vec3 } from '../types/scene'
import { TYPE_COLORS } from './scene'

/** 兼容任意历史/外部 JSON 的宽松输入结构 */
type RawDocument = {
  version?: unknown
  name?: unknown
  objects?: unknown
  prefabs?: unknown
  savedAt?: unknown
}

const VEC_FIELDS: Array<keyof Pick<SceneObject, 'position' | 'rotation' | 'scale'>> = ['position', 'rotation', 'scale']

function asVec3(value: unknown, fallback: Vec3): Vec3 {
  if (Array.isArray(value) && value.length >= 3 && value.every((item) => typeof item === 'number')) {
    return [value[0] as number, value[1] as number, value[2] as number]
  }
  return [...fallback]
}

function asBoolean(value: unknown, fallback: boolean) {
  return typeof value === 'boolean' ? value : fallback
}

function asNumber(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asString(value: unknown, fallback: string) {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

const KNOWN_TYPES: ObjectType[] = [
  'box',
  'sphere',
  'cylinder',
  'cone',
  'torus',
  'plane',
  'group',
  'directionalLight',
  'pointLight',
  'spotLight',
  'camera',
]

function normalizeMaterial(raw: unknown, type: ObjectType): MaterialSpec {
  const data = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    color: asString(data.color, TYPE_COLORS[type] ?? '#888888'),
    roughness: asNumber(data.roughness, 0.45),
    metalness: asNumber(data.metalness, 0.05),
    opacity: asNumber(data.opacity, 1),
    wireframe: asBoolean(data.wireframe, false),
  }
}

/** 规范化单个对象，补齐组合件功能上线前可能缺失的字段 */
export function normalizeObject(raw: unknown, index = 0): SceneObject | null {
  if (!raw || typeof raw !== 'object') return null
  const data = raw as Record<string, unknown>
  const type = KNOWN_TYPES.includes(data.type as ObjectType) ? (data.type as ObjectType) : 'box'
  const object: SceneObject = {
    id: asString(data.id, `legacy-${index}-${Math.random().toString(36).slice(2, 8)}`),
    name: asString(data.name, `对象 ${index + 1}`),
    type,
    parentId: typeof data.parentId === 'string' ? data.parentId : null,
    visible: asBoolean(data.visible, true),
    position: asVec3(data.position, [0, 0.8, 0]),
    rotation: asVec3(data.rotation, [0, 0, 0]),
    scale: asVec3(data.scale, [1, 1, 1]),
    castShadow: asBoolean(data.castShadow, type !== 'plane' && !type.includes('Light') && type !== 'camera' && type !== 'group'),
    receiveShadow: asBoolean(data.receiveShadow, true),
    material: normalizeMaterial(data.material, type),
  }
  if (typeof data.intensity === 'number') object.intensity = data.intensity
  if (typeof data.distance === 'number') object.distance = data.distance
  if (typeof data.fov === 'number') object.fov = data.fov
  if (typeof data.activeCamera === 'boolean') object.activeCamera = data.activeCamera
  if (typeof data.instanceOf === 'string' && data.instanceOf) object.instanceOf = data.instanceOf
  if (Array.isArray(data.overrides)) object.overrides = data.overrides as SceneObject['overrides']
  return object
}

function normalizePrefab(raw: unknown, index: number): PrefabAsset | null {
  if (!raw || typeof raw !== 'object') return null
  const data = raw as Record<string, unknown>
  const id = asString(data.id, `prefab-${index}`)
  const nodes = Array.isArray(data.nodes)
    ? (data.nodes.map((node, nodeIndex) => normalizeObject(node, nodeIndex)).filter(Boolean) as SceneObject[])
    : []
  if (nodes.length === 0) return null
  return {
    id,
    name: asString(data.name, `组合件 ${index + 1}`),
    nodes,
    createdAt: asString(data.createdAt, new Date().toISOString()),
  }
}

/**
 * 把任意历史版本的场景文档升级到当前版本再读入：
 * - 无 version / version=1：补 prefabs、规范化字段
 * - version=2：仅做字段兜底
 * 迁移是纯函数，不修改入参。
 */
export function migrateDocument(input: unknown): { document: SceneDocument; fromVersion: number | null } {
  const raw = (input && typeof input === 'object' ? input : {}) as RawDocument
  const fromVersion = typeof raw.version === 'number' ? raw.version : null

  const objects = Array.isArray(raw.objects)
    ? (raw.objects.map((item, index) => normalizeObject(item, index)).filter(Boolean) as SceneObject[])
    : []

  const prefabs = Array.isArray(raw.prefabs)
    ? (raw.prefabs.map((item, index) => normalizePrefab(item, index)).filter(Boolean) as PrefabAsset[])
    : []

  // v1 的 parentId 可能指向已被规范化丢弃的对象，统一回收到根
  const validIds = new Set(objects.map((object) => object.id))
  objects.forEach((object) => {
    if (object.parentId && !validIds.has(object.parentId)) object.parentId = null
  })

  // 组合件模板内部同样回收悬空父引用
  prefabs.forEach((prefab) => {
    const ids = new Set(prefab.nodes.map((node) => node.id))
    prefab.nodes.forEach((node) => {
      if (node.parentId && !ids.has(node.parentId)) node.parentId = null
    })
  })

  const document: SceneDocument = {
    version: 2,
    name: asString(raw.name, '未命名场景'),
    objects,
    prefabs,
    savedAt: asString(raw.savedAt, new Date().toISOString()),
  }
  return { document, fromVersion }
}
