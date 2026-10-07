import {
  AppBar,
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  Slider,
  Snackbar,
  Stack,
  Toolbar,
  Tooltip,
  Typography,
} from '@mui/material'
import {
  CloudDownloadOutlined,
  CloudUploadOutlined,
  OpenWithOutlined,
  RotateRightOutlined,
  SaveOutlined,
  ScaleOutlined,
  SpeedOutlined,
  UndoOutlined,
} from '@mui/icons-material'
import { useEffect } from 'react'
import HierarchyPanel from '../components/HierarchyPanel'
import InspectorPanel from '../components/InspectorPanel'
import SceneViewport from '../components/SceneViewport'
import { useEditorStore } from '../stores/editor'
import type { SceneDocument, TransformMode } from '../types/scene'
import { resolveScene } from '../utils/prefabs'

export default function EditorView() {
  const store = useEditorStore()
  const resolved = resolveScene(store.objects, store.prefabs)
  const selectedObject = store.selectedKey ? resolved.nodes.get(store.selectedKey) : undefined

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (target.matches('input, textarea')) return
      if (event.key.toLowerCase() === 'g') store.setTransformMode('translate')
      if (event.key.toLowerCase() === 'r') store.setTransformMode('rotate')
      if (event.key.toLowerCase() === 's') store.setTransformMode('scale')
      if ((event.key === 'Delete' || event.key === 'Backspace') && store.selectedKey) store.remove(store.selectedKey)
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        exportScene()
      }
      if (event.key === 'Escape') store.exitPrefab()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  function exportScene() {
    const document: SceneDocument = {
      version: 2,
      name: store.name,
      objects: store.objects,
      prefabs: store.prefabs,
      savedAt: new Date().toISOString(),
    }
    const blob = new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = window.document.createElement('a')
    anchor.href = url
    anchor.download = `${store.name}.scene.json`
    anchor.click()
    URL.revokeObjectURL(url)
    store.noticeMessage('场景 JSON 已保存（含组合件定义）')
  }

  async function importScene(file: File) {
    try {
      const parsed = JSON.parse(await file.text()) as unknown
      if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { objects?: unknown }).objects)) {
        store.loadScene(parsed)
      } else {
        throw new Error('场景 JSON 缺少 objects')
      }
    } catch (error) {
      store.noticeMessage(error instanceof Error ? error.message : '场景文件无效')
    }
  }

  const modes: Array<{ value: TransformMode; label: string; icon: React.ReactNode }> = [
    { value: 'translate', label: '移动', icon: <OpenWithOutlined /> },
    { value: 'rotate', label: '旋转', icon: <RotateRightOutlined /> },
    { value: 'scale', label: '缩放', icon: <ScaleOutlined /> },
  ]

  return (
    <Box className="app-shell">
      <AppBar position="static" color="inherit" elevation={0} className="topbar">
        <Toolbar variant="dense" sx={{ gap: 1.5 }}>
          <Box className="brand-mark">SF</Box>
          <Box sx={{ minWidth: 170 }}>
            <Typography variant="subtitle1" fontWeight={800}>SceneForge</Typography>
            <Typography variant="caption" color="text.secondary">三维场景编辑器</Typography>
          </Box>
          <Button variant="outlined" size="small" onClick={() => store.setPerformance({ instanceMode: !store.performance.instanceMode })}>
            {store.performance.instanceMode ? '实例模式：开' : '实例模式：关'}
          </Button>
          <Button variant="outlined" size="small" startIcon={<SpeedOutlined />} onClick={() => store.addStressObjects(240)}>压力测试 240</Button>
          {store.prefabs[0] && (
            <Button
              variant="outlined"
              size="small"
              color="secondary"
              onClick={() => {
                for (let i = 0; i < 60; i += 1) store.addPrefabInstance(store.prefabs[0].id)
              }}
            >
              放置 60 个引用
            </Button>
          )}
          {store.editingPrefabId && (
            <Button size="small" variant="contained" color="secondary" onClick={store.exitPrefab}>返回场景（Esc）</Button>
          )}
          <Stack direction="row" spacing={0.5}>
            {modes.map((mode) => (
              <Tooltip key={mode.value} title={mode.label}>
                <Button
                  size="small"
                  variant={store.transformMode === mode.value ? 'contained' : 'outlined'}
                  startIcon={mode.icon}
                  onClick={() => store.setTransformMode(mode.value)}
                >
                  {mode.label}
                </Button>
              </Tooltip>
            ))}
          </Stack>
          <FormControlLabel
            control={<Checkbox size="small" checked={store.snapEnabled} onChange={(event) => store.setSnapEnabled(event.target.checked)} />}
            label="吸附"
          />
          <Box sx={{ width: 110 }}>
            <Typography variant="caption">步长 {store.snapSize}</Typography>
            <Slider size="small" min={0.1} max={1} step={0.05} value={store.snapSize} onChange={(_, value) => store.setSnapSize(value as number)} />
          </Box>
          <Box sx={{ flex: 1 }} />
          <Button size="small" startIcon={<UndoOutlined />} onClick={store.reset}>重置</Button>
          <Button size="small" component="label" startIcon={<CloudUploadOutlined />}>
            导入
            <input hidden type="file" accept=".json" onChange={(event) => event.target.files?.[0] && importScene(event.target.files[0])} />
          </Button>
          <Button size="small" startIcon={<CloudDownloadOutlined />} onClick={exportScene}>导出</Button>
          <Button size="small" variant="contained" startIcon={<SaveOutlined />} onClick={exportScene}>保存场景</Button>
        </Toolbar>
      </AppBar>
      <main className="editor-grid">
        <HierarchyPanel />
        <SceneViewport />
        <InspectorPanel />
      </main>
      <div className="statusbar">
        <span>{selectedObject ? `已选择：${selectedObject.name}` : '未选择对象'}</span>
        <span>
          场景对象 {store.objects.length} · 组合件 {store.prefabs.length} · 渲染节点 {resolved.nodes.size}
          {selectedObject ? ` · 位置 ${selectedObject.position.map((item) => item.toFixed(2)).join(' / ')}` : ''}
        </span>
        <span>
          {store.editingPrefabId ? '组合件源编辑中' : store.performance.instanceMode ? 'InstancedMesh 批量渲染' : '独立对象渲染'}
          {store.render.phase === 'batching' ? ` · 分批 ${store.render.done}/${store.render.total}` : ''}
          {store.render.phase === 'recovering' ? ' · 恢复现场' : ''}
        </span>
      </div>
      <Snackbar open={Boolean(store.notice)} autoHideDuration={2600} onClose={() => store.noticeMessage('')} message={store.notice} />
    </Box>
  )
}
