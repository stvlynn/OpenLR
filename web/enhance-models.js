export const ENHANCE_MODELS = {
  denoise: {
    id: 'oidn-rt-ldr-small',
    file: 'oidn-rt-ldr-small.onnx',
    license: 'Apache-2.0',
    bytes: 1272337,
    revision: '24f30f6b04fc6e8c3b1b1993227d230d3a9344f1',
    url: 'https://raw.githubusercontent.com/pmndrs/denoiser-weights/24f30f6b04fc6e8c3b1b1993227d230d3a9344f1/models/rt_ldr_small.onnx',
    scale: 1,
    channels: 3,
    halo: 64,
    alignment: 16
  },
  'super-resolution': {
    id: 'espcn-x3',
    file: 'espcn-x3.onnx',
    license: 'Apache-2.0',
    bytes: 240078,
    revision: '395472c4b6b92f788357237983d83fd913cfe7e3',
    url: 'https://huggingface.co/onnxmodelzoo/super-resolution-10/resolve/395472c4b6b92f788357237983d83fd913cfe7e3/super-resolution-10.onnx',
    scale: 3,
    channels: 1,
    halo: 8,
    alignment: 1
  }
}
