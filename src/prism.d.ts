declare module 'prism-media' {
  import type { Duplex } from 'node:stream'
  namespace prism {
    namespace opus {
      class OggDemuxer extends Duplex {}
      class Decoder extends Duplex {
        constructor(options: { rate: number; channels: number; frameSize: number })
      }
    }
  }
  export default prism
}
