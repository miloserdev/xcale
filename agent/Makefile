# make              dynamic build against the libraries of this machine
# make STATIC=1     fully static binary (needs the static libraries: libssl.a, libcrypto.a,
#                   libjansson.a, libsensors.a; best built with musl, e.g. on Alpine, because a
#                   glibc static binary still loads NSS libraries for getaddrinfo at run time)
# make CC=aarch64-linux-gnu-gcc   cross build (needs the target's libraries and PKG_CONFIG_LIBDIR)
CC      ?= gcc
CFLAGS  ?= -O2 -Wall -Wextra -std=gnu11
CFLAGS  += $(shell pkg-config --cflags jansson openssl)

ifdef STATIC
CFLAGS  += -static
LDLIBS  += $(shell pkg-config --libs --static jansson openssl) -lsensors -lm
else
LDLIBS  += $(shell pkg-config --libs jansson openssl) -lsensors
endif

OBJS = main.o sync.o run.o sensors.o ws.o

xcale-agent: $(OBJS)
	$(CC) $(CFLAGS) -o $@ $(OBJS) $(LDLIBS)

%.o: %.c agent.h ws.h
	$(CC) $(CFLAGS) -c -o $@ $<

clean:
	rm -f xcale-agent $(OBJS)

.PHONY: clean
