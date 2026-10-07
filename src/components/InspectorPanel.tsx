import {
  Box,
  Button,
  Checkbox,
  Chip,
  Divider,
  FormControlLabel,
  MenuItem,
  Slider,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import { AlignHorizontalCenter, ContentCopyOutlined, DeleteOutline, DiamondOutlined } from '@mui/icons-material'
import { useMemo } from 'react'
import type { SceneObject, Vec3 } from '../types/scene'
import { useEditorStore } from '../stores/editor'
import { TYPE_LABELS } from '../utils/scene'
import { resolveInstance } from '../utils/components'

function InstancePanel({ object }: { object: SceneObject }) {
  const components = useEditorStore((state) => state.components)
  const resetOverrides = useEditorStore((state) => state.resetOverrides)
  const applyToSource = useEditorStore((state) => state.applyToSource)
  const breakInstance = useEditorStore((state) => state.breakInstance)
  const component = components.find((item) => item.id === object.componentId)
  const overrides = object.overrides ?? { position: false, material: false }

  return (
    <Box sx={{ mb: 1.2, p: 1, borderRadius: 1, bgcolor: '#f5f3ff', border: '1px solid #ddd6fe' }}>
      <Typography variant="subtitle2" sx={{ display: 'flex', alignItems: 'center', gap: 0.6, color: '#6d28d9' }}>
        <DiamondOutlined fontSize="small" /> 组合件引用实例
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.3 }}>
        源组合件：{component?.name ?? '（已删除）'}
      </Typography>
      <Stack direction="row" spacing={0.5} sx={{ mt: 0.8, flexWrap: 'wrap', gap: 0.4 }}>
        <Chip size="small" label={overrides.position ? '位置已覆盖' : '位置跟随源'} color={overrides.position ? 'warning' : 'default'} sx={{ height: 20, fontSize: 10 }} />
        <Chip size="small" label={overrides.material ? '材质已覆盖' : '材质跟随源'} color={overrides.material ? 'warning' : 'default'} sx={{ height: 20, fontSize: 10 }} />
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.6 }}>
        未覆盖的属性会随源组合件更新；覆盖后源改动盖不掉。
      </Typography>
      <Stack direction="row" spacing={0.5} sx={{ mt: 0.8, flexWrap: 'wrap', gap: 0.4 }}>
        <Button size="small" variant="outlined" disabled={!overrides.position} onClick={() => resetOverrides(object.id, 'position')}>重置位置</Button>
        <Button size="small" variant="outlined" disabled={!overrides.material} onClick={() => resetOverrides(object.id, 'material')}>重置材质</Button>
        <Button size="small" variant="outlined" disabled={!overrides.position && !overrides.material} onClick={() => resetOverrides(object.id)}>全部重置</Button>
      </Stack>
      <Stack direction="row" spacing={0.5} sx={{ mt: 0.6 }}>
        <Button size="small" variant="contained" onClick={() => applyToSource(object.id)}>应用到源</Button>
        <Button size="small" onClick={() => breakInstance(object.id)}>解除引用</Button>
      </Stack>
    </Box>
  )
}

function VectorEditor({ label, value, onChange }: { label: string; value: Vec3; onChange: (value: Vec3) => void }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
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
  const object = useEditorStore((state) => state.objects.find((item) => item.id === state.selectedId))
  const objects = useEditorStore((state) => state.objects)
  const update = useEditorStore((state) => state.update)
  const remove = useEditorStore((state) => state.remove)
  const duplicate = useEditorStore((state) => state.duplicate)
  const align = useEditorStore((state) => state.align)
  const components = useEditorStore((state) => state.components)
  // 未覆盖的引用实例，检查器显示跟随源组合件的有效值，而不是实例里存的旧值
  const displayObject = useMemo(() => {
    if (!object?.componentId) return object
    const resolved = resolveInstance(object, components)
    return {
      ...object,
      position: resolved.object.position,
      rotation: resolved.object.rotation,
      scale: resolved.object.scale,
      material: resolved.object.material,
    }
  }, [object, components])
  if (!object || !displayObject) {
    return <aside className="panel inspector-panel"><Typography variant="subtitle2">属性检查器</Typography><Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>在层级树或视口中选择对象。</Typography></aside>
  }

  const patch = (value: Partial<SceneObject>) => update(object.id, value)
  return (
    <aside className="panel inspector-panel">
      <div className="panel-heading"><div><Typography variant="subtitle2">属性检查器</Typography><Typography variant="caption" color="text.secondary">{TYPE_LABELS[object.type]} · {object.id}</Typography></div></div>
      {object.componentId && <InstancePanel object={object} />}
      <Stack spacing={1.2}>
        <TextField label="对象名称" size="small" value={object.name} onChange={(event) => patch({ name: event.target.value })} />
        <TextField select label="父级对象" size="small" value={object.parentId ?? ''} onChange={(event) => patch({ parentId: event.target.value || null })}>
          <MenuItem value="">场景根节点</MenuItem>
          {objects.filter((item) => item.id !== object.id).map((item) => <MenuItem key={item.id} value={item.id}>{item.name}</MenuItem>)}
        </TextField>
        <VectorEditor label="位置 Position" value={displayObject.position} onChange={(position) => patch({ position })} />
        <VectorEditor label="旋转 Rotation" value={displayObject.rotation} onChange={(rotation) => patch({ rotation })} />
        <VectorEditor label="缩放 Scale" value={displayObject.scale} onChange={(scale) => patch({ scale })} />
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
        <TextField label="颜色" type="color" size="small" value={displayObject.material.color} onChange={(event) => patch({ material: { ...displayObject.material, color: event.target.value } })} />
        <Box><Typography variant="caption">粗糙度 {displayObject.material.roughness.toFixed(2)}</Typography><Slider size="small" min={0} max={1} step={0.01} value={displayObject.material.roughness} onChange={(_, value) => patch({ material: { ...displayObject.material, roughness: value as number } })} /></Box>
        <Box><Typography variant="caption">金属度 {displayObject.material.metalness.toFixed(2)}</Typography><Slider size="small" min={0} max={1} step={0.01} value={displayObject.material.metalness} onChange={(_, value) => patch({ material: { ...displayObject.material, metalness: value as number } })} /></Box>
        <Box><Typography variant="caption">不透明度 {displayObject.material.opacity.toFixed(2)}</Typography><Slider size="small" min={0.05} max={1} step={0.01} value={displayObject.material.opacity} onChange={(_, value) => patch({ material: { ...displayObject.material, opacity: value as number } })} /></Box>
        <FormControlLabel control={<Checkbox size="small" checked={displayObject.material.wireframe} onChange={(event) => patch({ material: { ...displayObject.material, wireframe: event.target.checked } })} />} label="线框模式" />
        <FormControlLabel control={<Checkbox size="small" checked={object.castShadow} onChange={(event) => patch({ castShadow: event.target.checked })} />} label="投射阴影" />
        <FormControlLabel control={<Checkbox size="small" checked={object.receiveShadow} onChange={(event) => patch({ receiveShadow: event.target.checked })} />} label="接收阴影" />
        {object.type.includes('Light') && (
          <>
            <Typography variant="caption">光照强度 {object.intensity ?? 1}</Typography>
            <Slider size="small" min={0} max={8} step={0.1} value={object.intensity ?? 1} onChange={(_, value) => patch({ intensity: value as number })} />
          </>
        )}
        {object.type === 'camera' && (
          <FormControlLabel control={<Checkbox size="small" checked={object.activeCamera} onChange={(event) => patch({ activeCamera: event.target.checked })} />} label="设为活动相机" />
        )}
      </Stack>
      <Divider sx={{ my: 1.6 }} />
      <Stack direction="row" spacing={1}>
        <Button fullWidth variant="outlined" startIcon={<ContentCopyOutlined />} onClick={() => duplicate(object.id)}>复制</Button>
        <Button fullWidth color="error" variant="outlined" startIcon={<DeleteOutline />} onClick={() => remove(object.id)}>删除</Button>
      </Stack>
    </aside>
  )
}
