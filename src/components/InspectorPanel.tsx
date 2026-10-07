import {
  Alert,
  Box,
  Button,
  Checkbox,
  Divider,
  FormControlLabel,
  MenuItem,
  Slider,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import {
  AlignHorizontalCenter,
  ContentCopyOutlined,
  DeleteOutline,
  DifferenceOutlined,
  EditOutlined,
  RestartAltOutlined,
} from '@mui/icons-material'
import type { OverridePatch, SceneObject, Vec3 } from '../types/scene'
import { useEditorStore } from '../stores/editor'
import { TYPE_LABELS } from '../utils/scene'
import { resolvePrefab, resolveScene, parseInstanceKey } from '../utils/prefabs'

function VectorEditor({
  label,
  value,
  onChange,
  onReset,
}: {
  label: string
  value: Vec3
  onChange: (value: Vec3) => void
  onReset?: () => void
}) {
  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Typography variant="caption" color="text.secondary">{label}</Typography>
        {onReset && (
          <Tooltip title="恢复跟随组合件源">
            <Button size="small" sx={{ minWidth: 0, p: 0 }} onClick={onReset}><RestartAltOutlined fontSize="small" /></Button>
          </Tooltip>
        )}
      </Box>
      <Stack direction="row" spacing={0.6} sx={{ mt: 0.4 }}>
        {value.map((item, axis) => (
          <TextField
            key={axis}
            size="small"
            type="number"
            value={Number(item.toFixed(3))}
            inputProps={{ step: 0.1, 'aria-label': `${label}-${axis}` }}
            onChange={(event) => {
              const next: Vec3 = [...value]
              next[axis] = Number(event.target.value)
              onChange(next)
            }}
          />
        ))}
      </Stack>
    </Box>
  )
}

export default function InspectorPanel() {
  const objects = useEditorStore((state) => state.objects)
  const prefabs = useEditorStore((state) => state.prefabs)
  const selectedKey = useEditorStore((state) => state.selectedKey)
  const editingPrefabId = useEditorStore((state) => state.editingPrefabId)
  const updateNode = useEditorStore((state) => state.updateNode)
  const remove = useEditorStore((state) => state.remove)
  const duplicate = useEditorStore((state) => state.duplicate)
  const align = useEditorStore((state) => state.align)
  const enterPrefab = useEditorStore((state) => state.enterPrefab)
  const resetOverride = useEditorStore((state) => state.resetOverride)
  const resetAllOverrides = useEditorStore((state) => state.resetAllOverrides)

  const resolved = editingPrefabId
    ? resolvePrefab(prefabs.find((item) => item.id === editingPrefabId)!, prefabs)
    : resolveScene(objects, prefabs)

  if (!selectedKey) {
    return (
      <aside className="panel inspector-panel">
        <Typography variant="subtitle2">属性检查器</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>在层级树或视口中选择对象。</Typography>
      </aside>
    )
  }

  const parsed = parseInstanceKey(selectedKey)
  const resolvedNode = parsed ? resolved.nodes.get(selectedKey) : undefined
  const sceneObject = !parsed ? objects.find((item) => item.id === selectedKey) : undefined
  const editingNode = editingPrefabId
    ? prefabs.find((item) => item.id === editingPrefabId)?.nodes.find((item) => item.id === selectedKey)
    : undefined

  // 显示/编辑所依据的节点：普通对象或实例部件（解析值）
  const node: SceneObject | undefined = editingNode ?? sceneObject ?? resolvedNode
  if (!node) {
    return (
      <aside className="panel inspector-panel">
        <Typography variant="subtitle2">属性检查器</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>所选对象不存在。</Typography>
      </aside>
    )
  }

  const instanceHandle = parsed ? objects.find((item) => item.id === parsed.instanceId) : undefined
  const prefabAsset = instanceHandle?.instanceOf ? prefabs.find((item) => item.id === instanceHandle.instanceOf) : undefined
  const ownOverride = instanceHandle?.overrides?.find((item) => item.nodePath === parsed?.nodePath)
  const patchNode = (value: Partial<SceneObject>) => updateNode(selectedKey, value)
  // 只提交改了的材质属性，其余属性继续跟随组合件源
  const patchMaterial = (value: Partial<SceneObject['material']>) =>
    updateNode(selectedKey, { material: value })

  const overriddenFields = new Set<keyof OverridePatch | `material.${string}`>()
  if (ownOverride) {
    ;(['position', 'rotation', 'scale', 'visible', 'castShadow', 'receiveShadow', 'intensity', 'distance', 'fov', 'activeCamera'] as const).forEach((field) => {
      if (ownOverride.patch[field] !== undefined) overriddenFields.add(field)
    })
    if (ownOverride.patch.material) {
      ;(Object.keys(ownOverride.patch.material) as Array<keyof SceneObject['material']>).forEach((field) =>
        overriddenFields.add(`material.${field}`))
    }
  }

  const isInstancePart = Boolean(parsed && instanceHandle)
  const isHandle = Boolean(sceneObject?.instanceOf)
  const handleAsset = isHandle && sceneObject
    ? prefabs.find((item) => item.id === sceneObject.instanceOf)
    : undefined
  const resetField = (field: keyof OverridePatch | `material.${keyof SceneObject['material']}`) => {
    if (parsed) resetOverride(parsed.instanceId, parsed.nodePath, field)
  }

  return (
    <aside className="panel inspector-panel">
      <div className="panel-heading">
        <div>
          <Typography variant="subtitle2">{node.name}</Typography>
          <Typography variant="caption" color="text.secondary">{TYPE_LABELS[node.type]} · {selectedKey}</Typography>
        </div>
      </div>

      {editingPrefabId && (
        <Alert severity="info" sx={{ mb: 1, py: 0 }}>
          正在编辑组合件源：改动会传播到所有未单独覆盖的引用实例
        </Alert>
      )}
      {isInstancePart && prefabAsset && (
        <Alert severity="warning" sx={{ mb: 1, py: 0 }} icon={<DifferenceOutlined fontSize="small" />}>
          这是「{prefabAsset.name}」的实例部件（实例 {instanceHandle!.name}）。在此修改会成为私有覆盖，源改不动它。
        </Alert>
      )}
      {isHandle && handleAsset && (
        <Stack spacing={0.6} sx={{ mb: 1 }}>
          <Alert severity="info" sx={{ py: 0 }} icon={<DifferenceOutlined fontSize="small" />}>
            组合件「{handleAsset.name}」的引用实例。整体位置/旋转/缩放是私有摆放，内部默认跟随源。
          </Alert>
          <Button size="small" variant="outlined" startIcon={<EditOutlined />} onClick={() => enterPrefab(handleAsset.id)}>
            编辑组合件源「{handleAsset.name}」
          </Button>
          <Button size="small" startIcon={<RestartAltOutlined />} onClick={() => resetAllOverrides(sceneObject!.id)}>
            全部恢复跟随源（清除 {sceneObject!.overrides?.length ?? 0} 条覆盖）
          </Button>
        </Stack>
      )}

      <Stack spacing={1.2}>
        <TextField label="对象名称" size="small" value={node.name} onChange={(event) => patchNode({ name: event.target.value })} />
        {!parsed && !editingPrefabId && (
          <TextField
            select
            label="父级对象"
            size="small"
            value={node.parentId ?? ''}
            onChange={(event) => patchNode({ parentId: event.target.value || null })}
          >
            <MenuItem value="">场景根节点</MenuItem>
            {objects.filter((item) => item.id !== node.id).map((item) => (
              <MenuItem key={item.id} value={item.id}>{item.name}</MenuItem>
            ))}
          </TextField>
        )}
        <VectorEditor
          label={`位置 Position${overriddenFields.has('position') ? ' · 已覆盖' : ''}`}
          value={node.position}
          onChange={(position) => patchNode({ position })}
          onReset={isInstancePart ? () => resetField('position') : undefined}
        />
        <VectorEditor
          label={`旋转 Rotation${overriddenFields.has('rotation') ? ' · 已覆盖' : ''}`}
          value={node.rotation}
          onChange={(rotation) => patchNode({ rotation })}
          onReset={isInstancePart ? () => resetField('rotation') : undefined}
        />
        <VectorEditor
          label={`缩放 Scale${overriddenFields.has('scale') ? ' · 已覆盖' : ''}`}
          value={node.scale}
          onChange={(scale) => patchNode({ scale })}
          onReset={isInstancePart ? () => resetField('scale') : undefined}
        />
        <Stack direction="row" spacing={0.6}>
          {[0, 1, 2].map((axis) => (
            <Tooltip key={axis} title={`对齐 ${['X', 'Y', 'Z'][axis]} 轴`}>
              <Button size="small" variant="outlined" startIcon={<AlignHorizontalCenter />} onClick={() => align(axis as 0 | 1 | 2)}>{['X', 'Y', 'Z'][axis]}</Button>
            </Tooltip>
          ))}
        </Stack>
      </Stack>

      <Divider sx={{ my: 1.6 }} />
      <Typography variant="subtitle2" sx={{ mb: 1 }}>外观与阴影</Typography>
      <Stack spacing={1}>
        <FieldOverridden active={overriddenFields.has('material.color')} onReset={() => resetField('material.color')} label="颜色">
          <TextField label="颜色" type="color" size="small" value={node.material.color} onChange={(event) => patchMaterial({ color: event.target.value })} />
        </FieldOverridden>
        <MaterialSlider label="粗糙度" value={node.material.roughness} overridden={overriddenFields.has('material.roughness')} onReset={() => resetField('material.roughness')} onChange={(roughness) => patchMaterial({ roughness })} />
        <MaterialSlider label="金属度" value={node.material.metalness} overridden={overriddenFields.has('material.metalness')} onReset={() => resetField('material.metalness')} onChange={(metalness) => patchMaterial({ metalness })} />
        <MaterialSlider label="不透明度" min={0.05} value={node.material.opacity} overridden={overriddenFields.has('material.opacity')} onReset={() => resetField('material.opacity')} onChange={(opacity) => patchMaterial({ opacity })} />
        <FormControlLabel
          control={<Checkbox size="small" checked={node.material.wireframe} onChange={(event) => patchMaterial({ wireframe: event.target.checked })} />}
          label="线框模式"
        />
        <FormControlLabel
          control={<Checkbox size="small" checked={node.castShadow} onChange={(event) => patchNode({ castShadow: event.target.checked })} />}
          label="投射阴影"
        />
        <FormControlLabel
          control={<Checkbox size="small" checked={node.receiveShadow} onChange={(event) => patchNode({ receiveShadow: event.target.checked })} />}
          label="接收阴影"
        />
        {node.type.includes('Light') && (
          <>
            <Typography variant="caption">光照强度 {node.intensity ?? 1}</Typography>
            <Slider size="small" min={0} max={8} step={0.1} value={node.intensity ?? 1} onChange={(_, value) => patchNode({ intensity: value as number })} />
          </>
        )}
        {node.type === 'camera' && (
          <FormControlLabel control={<Checkbox size="small" checked={Boolean(node.activeCamera)} onChange={(event) => patchNode({ activeCamera: event.target.checked })} />} label="设为活动相机" />
        )}
      </Stack>

      <Divider sx={{ my: 1.6 }} />
      <Stack direction="row" spacing={1}>
        <Button fullWidth variant="outlined" startIcon={<ContentCopyOutlined />} onClick={() => duplicate(selectedKey)}>
          {isInstancePart ? '复制整个实例' : '复制'}
        </Button>
        <Button
          fullWidth
          color={isInstancePart ? 'inherit' : 'error'}
          variant="outlined"
          startIcon={<DeleteOutline />}
          onClick={() => remove(selectedKey)}
          disabled={isInstancePart}
        >
          {isInstancePart ? '部件随源删除' : '删除'}
        </Button>
      </Stack>
    </aside>
  )
}

function MaterialSlider({
  label,
  value,
  onChange,
  overridden,
  onReset,
  min = 0,
}: {
  label: string
  value: number
  onChange: (value: number) => void
  overridden?: boolean
  onReset?: () => void
  min?: number
}) {
  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Typography variant="caption">{label} {value.toFixed(2)}{overridden ? ' · 已覆盖' : ''}</Typography>
        {overridden && (
          <Tooltip title="恢复跟随组合件源">
            <Button size="small" sx={{ minWidth: 0, p: 0 }} onClick={onReset}><RestartAltOutlined fontSize="small" /></Button>
          </Tooltip>
        )}
      </Box>
      <Slider size="small" min={min} max={1} step={0.01} value={value} onChange={(_, next) => onChange(next as number)} />
    </Box>
  )
}

function FieldOverridden({
  active,
  onReset,
  label,
  children,
}: {
  active?: boolean
  onReset?: () => void
  label: string
  children: React.ReactNode
}) {
  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6 }}>
        <Box sx={{ flex: 1 }}>{children}</Box>
        {active && (
          <Tooltip title={`${label}已覆盖，恢复跟随源`}>
            <Button size="small" sx={{ minWidth: 0 }} onClick={onReset}><RestartAltOutlined fontSize="small" /></Button>
          </Tooltip>
        )}
      </Box>
    </Box>
  )
}
