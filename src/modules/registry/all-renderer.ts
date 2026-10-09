import type { RendererModule } from './renderer-types'
import { s3Renderer } from '../s3/renderer'
import { dockerRenderer } from '../docker/renderer'
import { k8sRenderer } from '../k8s/renderer'

/** Module chính thức phía renderer — import tĩnh (ADR-014 mục 3.9); component nặng nạp lazy. */
export const RENDERER_MODULES: readonly RendererModule[] = [s3Renderer, dockerRenderer, k8sRenderer]
