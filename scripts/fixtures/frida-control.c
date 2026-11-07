#include <stdio.h>
#include <unistd.h>

int main(void) {
    printf("{\"fridaControlReady\":%ld}\n", (long)getpid());
    fflush(stdout);
    return getchar() == '\n' ? 0 : 2;
}
