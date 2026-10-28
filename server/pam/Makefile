CC     ?= gcc
CFLAGS ?= -O2 -Wall -Wextra -std=gnu11

xcale-pam: pam-helper.c
	$(CC) $(CFLAGS) -o $@ pam-helper.c -lpam

clean:
	rm -f xcale-pam

.PHONY: clean
