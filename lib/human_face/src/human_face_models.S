/* The face models in flash, where the components' CMake would put them
   (target_add_aligned_binary_data): esp-dl reads them in place, 16-byte aligned.
   Paths are relative to the project folder, where the assembler runs. */
    .section .rodata.human_face_models, "a"

    .balign 16
    .global _binary_human_face_detect_espdl_start
_binary_human_face_detect_espdl_start:
    .incbin "lib/human_face/models/human_face_detect.espdl"

    .balign 16
    .global _binary_human_face_feat_espdl_start
_binary_human_face_feat_espdl_start:
    .incbin "lib/human_face/models/human_face_feat.espdl"
