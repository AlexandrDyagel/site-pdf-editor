<script setup lang="ts">
/** Запрос пароля для защищённого PDF. */
import { ref, watch } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppIcon from '@/components/ui/AppIcon.vue';

const props = defineProps<{ fileName?: string; loading?: boolean; error?: string | null }>();
const emit = defineEmits<{ submit: [password: string]; cancel: [] }>();

const password = ref('');

watch(
  () => props.fileName,
  () => {
    password.value = '';
  },
);

function submit(): void {
  if (!password.value) return;
  emit('submit', password.value);
}
</script>

<template>
  <div
    class="mx-auto w-full max-w-md rounded-2xl bg-white p-5 shadow-floating ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800"
  >
    <div class="flex items-start gap-3">
      <span
        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-600 dark:bg-amber-500/20 dark:text-amber-300"
      >
        <AppIcon name="lock" :size="19" />
      </span>
      <div>
        <h2 class="text-sm font-semibold text-slate-900 dark:text-slate-100">
          Документ защищён паролем
        </h2>
        <p class="mt-1 text-[12px] leading-snug text-slate-500 dark:text-slate-400">
          Введите пароль, чтобы открыть «{{ fileName || 'документ' }}». Пароль не отправляется
          на сервер и используется только в браузере.
        </p>
      </div>
    </div>

    <div class="mt-4 space-y-2">
      <AppInput
        v-model="password"
        type="password"
        size="sm"
        placeholder="Пароль"
        :error="error ?? undefined"
        @enter="submit"
      />
      <div class="flex justify-end gap-2">
        <AppButton variant="ghost" size="sm" @click="emit('cancel')">Отмена</AppButton>
        <AppButton
          variant="primary"
          size="sm"
          icon="key"
          :loading="loading"
          :disabled="!password"
          @click="submit"
        >
          Открыть
        </AppButton>
      </div>
    </div>
  </div>
</template>
