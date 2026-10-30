import type { PreviewTool } from '../previewTools';
import { annotationTool } from './annotationTool';
import { clipTool } from './clipTool';
import { cropTool } from './cropTool';
import { redactionTool } from './redactionTool';
import { zoomTool } from './zoomTool';

/** In priority order: the first tool to claim a press wins, so things drawn on top come first. */
export const PREVIEW_TOOLS: PreviewTool[] = [cropTool, annotationTool, redactionTool, zoomTool, clipTool];
