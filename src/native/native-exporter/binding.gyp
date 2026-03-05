{
  "targets": [
    {
      "target_name": "native_exporter",
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "sources": [
        "src/addon.cc",
        "src/d3d11_device.cc",
        "src/nvenc_loader.cc",
        "src/nvenc_encoder.cc",
        "src/compositor.cc",
        "src/texture_loader.cc",
        "src/video_decoder_mf.cc"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "include"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "NAPI_VERSION=8",
        "WIN32_LEAN_AND_MEAN",
        "NOMINMAX"
      ],
      "conditions": [
        ["OS=='win'", {
          "libraries": [
            "-ld3d11.lib",
            "-ldxgi.lib",
            "-ld3dcompiler.lib",
            "-lwindowscodecs.lib",
            "-lole32.lib",
            "-lmfplat.lib",
            "-lmfreadwrite.lib",
            "-lmfuuid.lib",
            "-lpropsys.lib"
          ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": ["/std:c++17"]
            }
          }
        }]
      ]
    }
  ]
}
