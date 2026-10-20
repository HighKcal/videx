use std::slice;

#[no_mangle]
pub extern "C" fn alloc_bytes(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len);
    let pointer = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    pointer
}

#[no_mangle]
pub extern "C" fn alloc_words(len: usize) -> *mut u32 {
    let mut buffer = Vec::<u32>::with_capacity(len);
    let pointer = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    pointer
}

#[no_mangle]
pub unsafe extern "C" fn free_bytes(pointer: *mut u8, len: usize) {
    if !pointer.is_null() && len > 0 {
        drop(Vec::from_raw_parts(pointer, 0, len));
    }
}

#[no_mangle]
pub unsafe extern "C" fn free_words(pointer: *mut u32, len: usize) {
    if !pointer.is_null() && len > 0 {
        drop(Vec::from_raw_parts(pointer, 0, len));
    }
}

/// ROI-constrained 4-neighbor flood fill. Output and queue are caller-owned
/// buffers, so repeated browser calls allocate no memory inside the kernel.
#[no_mangle]
pub unsafe extern "C" fn flood_fill(
    roi_ptr: *const u8,
    barriers_ptr: *const u8,
    output_ptr: *mut u8,
    queue_ptr: *mut u32,
    len: usize,
    seed: usize,
    width: usize,
    height: usize,
) -> i32 {
    if width == 0
        || height == 0
        || width.checked_mul(height) != Some(len)
        || seed >= len
        || roi_ptr.is_null()
        || barriers_ptr.is_null()
        || output_ptr.is_null()
        || queue_ptr.is_null()
    {
        return -1;
    }
    let roi = slice::from_raw_parts(roi_ptr, len);
    let barriers = slice::from_raw_parts(barriers_ptr, len);
    let output = slice::from_raw_parts_mut(output_ptr, len);
    let queue = slice::from_raw_parts_mut(queue_ptr, len);
    output.fill(0);
    if roi[seed] == 0 || barriers[seed] != 0 {
        return 0;
    }

    let mut read = 0usize;
    let mut write = 1usize;
    queue[0] = seed as u32;
    output[seed] = 1;
    while read < write {
        let index = queue[read] as usize;
        read += 1;
        let x = index % width;
        let y = index / width;
        if x > 0 {
            enqueue(index - 1, roi, barriers, output, queue, &mut write);
        }
        if x + 1 < width {
            enqueue(index + 1, roi, barriers, output, queue, &mut write);
        }
        if y > 0 {
            enqueue(index - width, roi, barriers, output, queue, &mut write);
        }
        if y + 1 < height {
            enqueue(index + width, roi, barriers, output, queue, &mut write);
        }
    }
    write as i32
}

unsafe fn enqueue(
    index: usize,
    roi: &[u8],
    barriers: &[u8],
    output: &mut [u8],
    queue: &mut [u32],
    write: &mut usize,
) {
    if roi[index] != 0 && barriers[index] == 0 && output[index] == 0 {
        output[index] = 1;
        queue[*write] = index as u32;
        *write += 1;
    }
}
