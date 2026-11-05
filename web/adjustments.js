import { mixerControls } from './color.js'

export const controls = {
  Light: {
    Exposure: [-5, 5, 0.05],
    Contrast: [-100, 100, 1],
    Highlights: [-100, 100, 1],
    Shadows: [-100, 100, 1],
    Whites: [-100, 100, 1],
    Blacks: [-100, 100, 1]
  },
  Color: {
    Temperature: [-100, 100, 1],
    Tint: [-100, 100, 1],
    Vibrance: [-100, 100, 1],
    Saturation: [-100, 100, 1]
  },
  Curve: {
    'Curve shadows': [-100, 100, 1],
    'Curve midtones': [-100, 100, 1],
    'Curve lights': [-100, 100, 1]
  },
  'Color mixer': mixerControls,
  Effects: {
    Dehaze: [-100, 100, 1],
    Texture: [-100, 100, 1],
    Clarity: [-100, 100, 1],
    Vignette: [-100, 100, 1],
    Grain: [0, 100, 1]
  },
  Detail: { Sharpening: [0, 100, 1], 'Noise reduction': [0, 100, 1] }
}
