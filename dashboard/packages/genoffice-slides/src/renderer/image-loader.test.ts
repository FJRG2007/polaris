/**
 * That every image a slide draws is one this walk finds.
 *
 * The two copies this replaces (Drive's viewer and this package's own App.tsx)
 * both missed a shape's fillOverlay and a chart's plot-area fill, which is a
 * picture that never loads and draws nothing, silently. This pins every site a
 * RenderFill or a picture dataUrl can sit at, so a site added to the renderer
 * without a matching line here fails loudly instead.
 */

import { describe, expect, it } from 'vitest'
import { collectImageUrls } from './image-loader'
import type { RenderFill, RenderNode, RenderSlide } from '@polaris/pptx-render'

const imageFill = (dataUrl: string): RenderFill => ({ kind: 'image', dataUrl, mode: 'stretch' })

const slideOf = (background: RenderFill, nodes: RenderNode[]): RenderSlide =>
  ({ widthPx: 100, heightPx: 100, background, nodes }) as RenderSlide

describe('collecting a deck image urls', () => {
  it('finds a slide background and a picture node', () => {
    const urls = collectImageUrls([
      slideOf(imageFill('data:image/png;base64,bg'), [
        { id: '1', type: 'picture', box: {}, sourceId: 's1', dataUrl: 'data:image/png;base64,pic' } as RenderNode
      ])
    ])
    expect(urls).toEqual(new Set(['data:image/png;base64,bg', 'data:image/png;base64,pic']))
  })

  it('finds a shape fill and its fillOverlay', () => {
    const urls = collectImageUrls([
      slideOf({ kind: 'none' }, [
        {
          id: '1',
          type: 'shape',
          box: {},
          sourceId: 's1',
          fill: imageFill('data:image/png;base64,fill'),
          fillOverlay: imageFill('data:image/png;base64,overlay')
        } as RenderNode
      ])
    ])
    expect(urls).toEqual(new Set(['data:image/png;base64,fill', 'data:image/png;base64,overlay']))
  })

  it('finds a chart background fill and its plot-area fill', () => {
    const urls = collectImageUrls([
      slideOf({ kind: 'none' }, [
        {
          id: '1',
          type: 'chart',
          box: {},
          sourceId: 's1',
          bgFill: imageFill('data:image/png;base64,chartbg'),
          plotRect: { x: 0, y: 0, w: 1, h: 1, fill: imageFill('data:image/png;base64,plot') },
          gridLines: [],
          axisLines: [],
          labels: [],
          bars: [],
          polylines: [],
          markers: [],
          swatches: []
        } as RenderNode
      ])
    ])
    expect(urls).toEqual(new Set(['data:image/png;base64,chartbg', 'data:image/png;base64,plot']))
  })

  it('finds a table background fill and every cell fill', () => {
    const urls = collectImageUrls([
      slideOf({ kind: 'none' }, [
        {
          id: '1',
          type: 'table',
          box: {},
          sourceId: 's1',
          bgFill: imageFill('data:image/png;base64,tablebg'),
          cells: [
            { x: 0, y: 0, w: 1, h: 1, row: 0, col: 0, fill: imageFill('data:image/png;base64,cell0') },
            { x: 1, y: 0, w: 1, h: 1, row: 0, col: 1, fill: { kind: 'none' } }
          ],
          gridX: [],
          gridY: []
        } as RenderNode
      ])
    ])
    expect(urls).toEqual(new Set(['data:image/png;base64,tablebg', 'data:image/png;base64,cell0']))
  })

  it('recurses into a group, keyed on the same set as the top level', () => {
    const urls = collectImageUrls([
      slideOf({ kind: 'none' }, [
        {
          id: '1',
          type: 'group',
          box: {},
          sourceId: 's1',
          children: [
            {
              id: '2',
              type: 'picture',
              box: {},
              sourceId: 's2',
              dataUrl: 'data:image/png;base64,nested'
            } as RenderNode
          ]
        } as RenderNode
      ])
    ])
    expect(urls).toEqual(new Set(['data:image/png;base64,nested']))
  })

  it('ignores a fill with no kind of image and a picture with no dataUrl', () => {
    const urls = collectImageUrls([
      slideOf({ kind: 'solid', color: '#fff' }, [
        { id: '1', type: 'picture', box: {}, sourceId: 's1' } as RenderNode,
        {
          id: '2',
          type: 'shape',
          box: {},
          sourceId: 's2',
          fill: { kind: 'solid', color: '#000' }
        } as RenderNode
      ])
    ])
    expect(urls.size).toBe(0)
  })
})
