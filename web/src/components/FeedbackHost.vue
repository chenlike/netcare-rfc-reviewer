<script setup lang="ts">
import { Toaster } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { confirmation, settleConfirmation } from "@/lib/feedback";
import { resolvedTheme } from "@/lib/theme";
</script>
<template>
  <Toaster
    :theme="resolvedTheme"
    position="bottom-right"
    :close-button="true"
  />
  <AlertDialog
    :open="!!confirmation"
    @update:open="(open) => !open && settleConfirmation(false)"
  >
    <AlertDialogContent>
      <AlertDialogHeader
        ><AlertDialogTitle>{{ confirmation?.title }}</AlertDialogTitle
        ><AlertDialogDescription class="break-words">{{
          confirmation?.message
        }}</AlertDialogDescription></AlertDialogHeader
      >
      <AlertDialogFooter
        ><AlertDialogCancel @click="settleConfirmation(false)"
          >取消</AlertDialogCancel
        ><Button @click="settleConfirmation(true)">{{
          confirmation?.action
        }}</Button></AlertDialogFooter
      >
    </AlertDialogContent>
  </AlertDialog>
</template>
