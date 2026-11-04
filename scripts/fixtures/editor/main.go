// A controlled native acceptance-test editor. It changes the pixels of the
// supplied uncompressed TIFF, writes it twice like an interactive editor save,
// and never reads or writes any other photograph.
package main

import (
	"encoding/binary"
	"fmt"
	"os"
	"time"
)

func main() {
	if len(os.Args) != 2 {
		panic("expected one generated TIFF fixture")
	}
	path := os.Args[1]
	data, err := os.ReadFile(path)
	if err != nil {
		panic(err)
	}
	var order binary.ByteOrder = binary.LittleEndian
	if string(data[:2]) == "MM" {
		order = binary.BigEndian
	}
	if len(data) < 8 || order.Uint16(data[2:4]) != 42 {
		panic("not a TIFF")
	}
	ifd := int(order.Uint32(data[4:8]))
	count := int(order.Uint16(data[ifd : ifd+2]))
	offset, length := 0, 0
	for i := 0; i < count; i++ {
		entry := data[ifd+2+i*12 : ifd+14+i*12]
		tag := order.Uint16(entry[:2])
		value := int(order.Uint32(entry[8:12]))
		if tag == 273 {
			offset = value
		}
		if tag == 279 {
			length = value
		}
	}
	if offset <= 0 || length <= 0 || offset+length > len(data) {
		panic("unsupported TIFF strip")
	}
	for i := offset; i < offset+length; i++ {
		if (i-offset)%4 != 3 {
			data[i] = 255 - data[i]
		}
	}
	time.Sleep(200 * time.Millisecond)
	if err = os.WriteFile(path, data, 0o600); err != nil {
		panic(err)
	}
	// Delayed flush/rewrite is intentional: consumers must wait for a stable file.
	time.Sleep(250 * time.Millisecond)
	if err = os.WriteFile(path, data, 0o600); err != nil {
		panic(err)
	}
	fmt.Println("Saved generated TIFF fixture")
}
