export const AI_TARGETS = ['subject', 'person', 'sky', 'background']
export const AI_MODELS = {
  subject: {
    file: 'u2netp.onnx',
    width: 320,
    height: 320,
    sha256: '309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8',
    license: 'Apache-2.0',
    revision: 'rembg-v0.0.0-u2netp'
  },
  person: {
    file: 'pphumanseg.onnx',
    width: 192,
    height: 192,
    sha256: '552d8a984054e59b5d773d24b9b12022b22046ceb2bbc4c9aaeaceb36a9ddf24',
    license: 'Apache-2.0',
    revision: 'opencv-zoo-48b10fa505aeb51fbd127fc60a5c660040e823b7'
  },
  sky: {
    file: 'detr-panoptic-fp32.onnx',
    shortEdge: 512,
    maxEdge: 1024,
    bytes: 172282717,
    optional: true,
    license: 'Apache-2.0',
    sha256: 'f41a80cd659d1ae2e4981f2423955d983d28657d747e965ddc980b7768042de1',
    revision: 'ea24b2d4e0bfae31f0a1299ba3fb892a2df064de',
    url: 'https://huggingface.co/Xenova/detr-resnet-50-panoptic/resolve/ea24b2d4e0bfae31f0a1299ba3fb892a2df064de/onnx/model.onnx',
    label: 187
  }
}
export const modelFor = (target) => AI_MODELS[target === 'background' ? 'subject' : target]
